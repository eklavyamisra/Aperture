-- Aperture: accounts, synced boards, uploaded images (roadmap #15–17) and share links (#18–19).
-- Run once in the Supabase dashboard: SQL Editor → New query → paste → Run.
-- Safe to re-run.

-- ---------- boards ----------
-- One row per board per person. `data` is the whole board (items, threads,
-- frames) exactly as the browser keeps it. `updated` is the browser's last
-- edit time in ms; sync keeps whichever copy is newer. Deleting a board keeps
-- a tombstone (deleted = true) so other devices drop it too.
create table if not exists public.boards (
    owner      uuid    not null default auth.uid() references auth.users (id) on delete cascade,
    id         text    not null check (id ~ '^[A-Za-z0-9_-]{1,40}$'),
    name       text    not null default '' check (char_length(name) <= 60),
    data       jsonb,
    updated    bigint  not null default 0,
    deleted    boolean not null default false,
    synced_at  timestamptz not null default now(),
    primary key (owner, id),
    -- a board is at most ~2 MB of JSON (the browser's own limit is ~5 MB for everything)
    constraint boards_data_size check (data is null or pg_column_size(data) < 2000000)
);

alter table public.boards enable row level security;

-- Table access: only signed-in users, and the policies below limit them to their own rows.
-- (Newer Supabase projects don't grant this automatically for tables made in SQL.)
revoke all on public.boards from anon;
grant select, insert, update, delete on public.boards to authenticated;

drop policy if exists "boards: owner reads"   on public.boards;
drop policy if exists "boards: owner inserts" on public.boards;
drop policy if exists "boards: owner updates" on public.boards;
drop policy if exists "boards: owner deletes" on public.boards;

create policy "boards: owner reads"   on public.boards for select using (owner = auth.uid());
create policy "boards: owner inserts" on public.boards for insert with check (owner = auth.uid());
create policy "boards: owner updates" on public.boards for update using (owner = auth.uid()) with check (owner = auth.uid());
create policy "boards: owner deletes" on public.boards for delete using (owner = auth.uid());

create or replace function public.boards_touch() returns trigger language plpgsql as $$
begin
    new.synced_at := now();
    return new;
end $$;

drop trigger if exists boards_touch on public.boards;
create trigger boards_touch before insert or update on public.boards
    for each row execute function public.boards_touch();

-- ---------- uploaded images ----------
-- Private bucket; each person's files live under "<their user id>/<item id>".
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('uploads', 'uploads', false, 15728640, array['image/webp', 'image/jpeg', 'image/png', 'image/gif', 'image/avif'])
on conflict (id) do update
    set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "uploads: owner reads"   on storage.objects;
drop policy if exists "uploads: owner writes"  on storage.objects;
drop policy if exists "uploads: owner updates" on storage.objects;
drop policy if exists "uploads: owner deletes" on storage.objects;

create policy "uploads: owner reads" on storage.objects for select
    using (bucket_id = 'uploads' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "uploads: owner writes" on storage.objects for insert
    with check (bucket_id = 'uploads' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "uploads: owner updates" on storage.objects for update
    using (bucket_id = 'uploads' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "uploads: owner deletes" on storage.objects for delete
    using (bucket_id = 'uploads' and (storage.foldername(name))[1] = auth.uid()::text);

-- ---------- share links (#18, #19) ----------
-- A share is a short code pointing at one of the owner's boards, so the link
-- (/b/<code>) always shows the board as it is now. The owner can add a
-- password, swap the code for a new one (the old link stops working) or delete
-- the share. Deleting the board, or the account's data, removes it too.
-- Nobody can list shares: a visitor can only look one up by its code through
-- shared_board() below.
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.shares (
    code        text not null primary key check (code ~ '^[A-Za-z0-9]{10,16}$'),
    owner       uuid not null default auth.uid() references auth.users (id) on delete cascade,
    board_id    text not null,
    created_at  timestamptz not null default now(),
    unique (owner, board_id),
    foreign key (owner, board_id) references public.boards (owner, id) on delete cascade
);
-- #19: optional password (bcrypt hash, never readable by the browser) and a count of wrong tries
alter table public.shares add column if not exists pass_hash   text;
alter table public.shares add column if not exists fails       integer not null default 0;
alter table public.shares add column if not exists fail_window timestamptz;
alter table public.shares add column if not exists protected   boolean generated always as (pass_hash is not null) stored;

alter table public.shares enable row level security;
-- column by column, so the password hash and try counts stay out of reach
revoke all on public.shares from anon, authenticated;
grant select (code, owner, board_id, created_at, protected) on public.shares to authenticated;
grant insert (code, owner, board_id) on public.shares to authenticated;
grant update (code) on public.shares to authenticated;
grant delete on public.shares to authenticated;

drop policy if exists "shares: owner reads"   on public.shares;
drop policy if exists "shares: owner inserts" on public.shares;
drop policy if exists "shares: owner updates" on public.shares;
drop policy if exists "shares: owner deletes" on public.shares;

create policy "shares: owner reads"   on public.shares for select using (owner = auth.uid());
create policy "shares: owner inserts" on public.shares for insert with check (owner = auth.uid());
create policy "shares: owner updates" on public.shares for update using (owner = auth.uid()) with check (owner = auth.uid());
create policy "shares: owner deletes" on public.shares for delete using (owner = auth.uid());

-- The owner sets (or with null, removes) a share's password. Hashed here, so
-- the browser never handles a hash.
create or replace function public.set_share_password(board text, password text)
returns void language plpgsql volatile security definer set search_path = public, extensions as $$
begin
    if auth.uid() is null then
        raise exception 'not signed in';
    end if;
    if password is not null and (char_length(password) < 4 or octet_length(password) > 72) then
        raise exception 'password must be 4 to 72 characters';
    end if;
    update public.shares
       set pass_hash = case when password is null then null else crypt(password, gen_salt('bf', 10)) end,
           fails = 0,
           fail_window = null
     where owner = auth.uid() and board_id = board;
    if not found then
        raise exception 'board is not shared';
    end if;
end $$;

revoke all on function public.set_share_password(text, text) from public, anon;
grant execute on function public.set_share_password(text, text) to authenticated;

-- The one public read: a board by its share code, minus uploaded images (they
-- live in each owner's private bucket). Answers with a status:
--   ok      the board (name, data, updated)
--   locked  it has a password and none was given
--   wrong   the password didn't match
--   slow    10 wrong tries in 15 minutes: no more checks until that window ends
-- No row: no such code, or the board is deleted.
drop function if exists public.shared_board(text);
create or replace function public.shared_board(share_code text, password text default null)
returns table (status text, name text, data jsonb, updated bigint)
language plpgsql volatile security definer set search_path = public, extensions as $$
#variable_conflict use_column
declare
    s public.shares%rowtype;
    recent boolean;
begin
    select sh.* into s
      from public.shares sh
      join public.boards b on b.owner = sh.owner and b.id = sh.board_id
     where sh.code = share_code and not b.deleted and jsonb_typeof(b.data) = 'object';
    if not found then
        return;
    end if;

    if s.pass_hash is not null then
        if password is null then
            return query select 'locked'::text, null::text, null::jsonb, null::bigint;
            return;
        end if;
        recent := s.fail_window is not null and s.fail_window > now() - interval '15 minutes';
        if recent and s.fails >= 10 then
            return query select 'slow'::text, null::text, null::jsonb, null::bigint;
            return;
        end if;
        if crypt(password, s.pass_hash) is distinct from s.pass_hash then
            update public.shares
               set fails = case when recent then fails + 1 else 1 end,
                   fail_window = case when recent then fail_window else now() end
             where code = s.code;
            return query select 'wrong'::text, null::text, null::jsonb, null::bigint;
            return;
        end if;
    end if;

    return query
        select 'ok'::text,
               b.name,
               jsonb_set(b.data, '{pins}', coalesce(
                   (select jsonb_agg(p)
                      from jsonb_array_elements(case when jsonb_typeof(b.data -> 'pins') = 'array' then b.data -> 'pins' else '[]'::jsonb end) p
                     where p ->> 'kind' is distinct from 'upload'),
                   '[]'::jsonb)),
               b.updated
          from public.boards b
         where b.owner = s.owner and b.id = s.board_id;
end $$;

revoke all on function public.shared_board(text, text) from public;
grant execute on function public.shared_board(text, text) to anon, authenticated;
