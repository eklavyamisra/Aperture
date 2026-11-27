-- Aperture: accounts, synced boards, uploaded images (roadmap #15–17), share links (#18–19), comments (#20) and live editing (#21).
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
-- #21: signed-in people with the link may edit, live. `room` names the board's
-- realtime channel; it is random and only the owner and editors ever see it.
alter table public.shares add column if not exists can_edit    boolean not null default false;
alter table public.shares add column if not exists room        text not null default replace(gen_random_uuid()::text, '-', '');
create unique index if not exists shares_room on public.shares (room);

alter table public.shares enable row level security;
-- column by column, so the password hash and try counts stay out of reach
revoke all on public.shares from anon, authenticated;
grant select (code, owner, board_id, created_at, protected, can_edit, room) on public.shares to authenticated;
grant insert (code, owner, board_id) on public.shares to authenticated;
grant update (code, can_edit) on public.shares to authenticated;
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

-- Internal: may this caller open the board behind a share code? Answers one row
--   ok      (with the board's owner and id)
--   locked  it has a password and none was given
--   wrong   the password didn't match
--   slow    10 wrong tries in 15 minutes: no more checks until that window ends
-- No row: no such code, or the board is deleted. The board's owner never needs
-- the password. Only the functions below call it.
create or replace function public.share_check(share_code text, password text)
returns table (status text, owner uuid, board_id text)
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

    if s.pass_hash is not null and s.owner is distinct from auth.uid() then
        if password is null then
            return query select 'locked'::text, null::uuid, null::text;
            return;
        end if;
        recent := s.fail_window is not null and s.fail_window > now() - interval '15 minutes';
        if recent and s.fails >= 10 then
            return query select 'slow'::text, null::uuid, null::text;
            return;
        end if;
        if crypt(password, s.pass_hash) is distinct from s.pass_hash then
            update public.shares
               set fails = case when recent then fails + 1 else 1 end,
                   fail_window = case when recent then fail_window else now() end
             where code = s.code;
            return query select 'wrong'::text, null::uuid, null::text;
            return;
        end if;
    end if;

    return query select 'ok'::text, s.owner, s.board_id;
end $$;

revoke all on function public.share_check(text, text) from public, anon, authenticated;

-- Internal: a board's data without its uploaded images (they live in each
-- owner's private bucket, so nobody else could load them anyway).
create or replace function public.without_uploads(data jsonb)
returns jsonb language sql immutable set search_path = public as $$
    select jsonb_set(data, '{pins}', coalesce(
        (select jsonb_agg(p)
           from jsonb_array_elements(case when jsonb_typeof(data -> 'pins') = 'array' then data -> 'pins' else '[]'::jsonb end) p
          where p ->> 'kind' is distinct from 'upload'),
        '[]'::jsonb))
$$;

revoke all on function public.without_uploads(jsonb) from public, anon, authenticated;

-- The one public read of a board: by its share code, minus uploaded images.
-- status is share_check()'s; name, data, updated and editable come only with 'ok'.
-- editable: signed-in people with the link can edit it (#21, join_board below).
drop function if exists public.shared_board(text);
drop function if exists public.shared_board(text, text);
create or replace function public.shared_board(share_code text, password text default null)
returns table (status text, name text, data jsonb, updated bigint, editable boolean)
language plpgsql volatile security definer set search_path = public, extensions as $$
#variable_conflict use_column
declare
    c record;
begin
    select * into c from public.share_check(share_code, password);
    if not found then
        return;
    end if;
    if c.status <> 'ok' then
        return query select c.status, null::text, null::jsonb, null::bigint, null::boolean;
        return;
    end if;
    return query
        select 'ok'::text, b.name, public.without_uploads(b.data), b.updated, s.can_edit
          from public.boards b
          join public.shares s on s.owner = b.owner and s.board_id = b.id
         where b.owner = c.owner and b.id = c.board_id;
end $$;

revoke all on function public.shared_board(text, text) from public;
grant execute on function public.shared_board(text, text) to anon, authenticated;


-- ---------- comments (#20) ----------
-- Comments belong to a board (not to a share code), so they survive "New link".
-- Anyone who can open the shared board can read them; only signed-in people can
-- write. A comment may point at one card (item_id). Its author or the board's
-- owner can delete it. Deleting the board, or either account, deletes them.
-- The table itself is closed: every read and write goes through the functions below.
create table if not exists public.comments (
    id          uuid primary key default gen_random_uuid(),
    board_owner uuid not null,
    board_id    text not null,
    author      uuid not null default auth.uid() references auth.users (id) on delete cascade,
    author_name text not null check (char_length(author_name) between 1 and 40),
    item_id     text check (item_id is null or item_id ~ '^[A-Za-z0-9_-]{1,64}$'),
    body        text not null check (char_length(body) between 1 and 1000),
    created_at  timestamptz not null default now(),
    foreign key (board_owner, board_id) references public.boards (owner, id) on delete cascade
);
create index if not exists comments_board on public.comments (board_owner, board_id, created_at);
create index if not exists comments_author on public.comments (author, created_at);

alter table public.comments enable row level security;
revoke all on public.comments from anon, authenticated;

-- Internal: the insert both ways of commenting share, with a limit of 20 comments
-- per person per 10 minutes.
create or replace function public.comment_insert(owner_id uuid, board text, item text, name text, body text)
returns uuid language plpgsql volatile security definer set search_path = public as $$
declare
    new_id uuid;
begin
    if auth.uid() is null then
        raise exception 'sign in to comment';
    end if;
    if (select count(*) from public.comments c where c.author = auth.uid() and c.created_at > now() - interval '10 minutes') >= 20 then
        raise exception 'too many comments, wait a few minutes';
    end if;
    insert into public.comments (board_owner, board_id, author, author_name, item_id, body)
    values (owner_id, board, auth.uid(), btrim(name), item, btrim(body))
    returning id into new_id;
    return new_id;
end $$;

revoke all on function public.comment_insert(uuid, text, text, text, text) from public, anon, authenticated;

-- Comments on a shared board, oldest first. status is share_check()'s: a row with
-- only a status (and no id) means the board can't be opened with what was given.
-- mine / can_delete are for the signed-in caller (false for visitors).
create or replace function public.share_comments(share_code text, password text default null)
returns table (status text, id uuid, author_name text, item_id text, body text, created_at timestamptz, mine boolean, can_delete boolean)
language plpgsql volatile security definer set search_path = public, extensions as $$
#variable_conflict use_column
declare
    c record;
begin
    select * into c from public.share_check(share_code, password);
    if not found then
        return;
    end if;
    if c.status <> 'ok' then
        return query select c.status, null::uuid, null::text, null::text, null::text, null::timestamptz, false, false;
        return;
    end if;
    return query
        select 'ok'::text, cm.id, cm.author_name, cm.item_id, cm.body, cm.created_at,
               coalesce(cm.author = auth.uid(), false),
               coalesce(cm.author = auth.uid() or cm.board_owner = auth.uid(), false)
          from public.comments cm
         where cm.board_owner = c.owner and cm.board_id = c.board_id
         order by cm.created_at
         limit 500;
end $$;

revoke all on function public.share_comments(text, text) from public;
grant execute on function public.share_comments(text, text) to anon, authenticated;

-- A signed-in visitor comments on a shared board (with the password, if it has one).
create or replace function public.add_comment(share_code text, password text, item text, name text, body text)
returns uuid language plpgsql volatile security definer set search_path = public, extensions as $$
declare
    c record;
begin
    if auth.uid() is null then
        raise exception 'sign in to comment';
    end if;
    select * into c from public.share_check(share_code, password);
    if not found then
        raise exception 'board is not shared';
    end if;
    if c.status = 'slow' then
        raise exception 'too many wrong tries';
    elsif c.status <> 'ok' then
        raise exception 'wrong password';
    end if;
    return public.comment_insert(c.owner, c.board_id, item, name, body);
end $$;

revoke all on function public.add_comment(text, text, text, text, text) from public, anon;
grant execute on function public.add_comment(text, text, text, text, text) to authenticated;

-- The owner reads, and replies to, comments on their own board (shared or not).
create or replace function public.board_comments(board text)
returns table (id uuid, author_name text, item_id text, body text, created_at timestamptz, mine boolean, can_delete boolean)
language sql stable security definer set search_path = public as $$
    select cm.id, cm.author_name, cm.item_id, cm.body, cm.created_at, cm.author = auth.uid(), true
      from public.comments cm
     where cm.board_owner = auth.uid() and cm.board_id = board
     order by cm.created_at
     limit 500
$$;

revoke all on function public.board_comments(text) from public, anon;
grant execute on function public.board_comments(text) to authenticated;

create or replace function public.add_board_comment(board text, item text, name text, body text)
returns uuid language plpgsql volatile security definer set search_path = public as $$
begin
    if auth.uid() is null or not exists (select 1 from public.boards b where b.owner = auth.uid() and b.id = board and not b.deleted) then
        raise exception 'not your board';
    end if;
    return public.comment_insert(auth.uid(), board, item, name, body);
end $$;

revoke all on function public.add_board_comment(text, text, text, text) from public, anon;
grant execute on function public.add_board_comment(text, text, text, text) to authenticated;

-- Its author or the board's owner deletes a comment.
create or replace function public.delete_comment(comment uuid)
returns void language plpgsql volatile security definer set search_path = public as $$
begin
    delete from public.comments c
     where c.id = comment and (c.author = auth.uid() or c.board_owner = auth.uid());
    if not found then
        raise exception 'not allowed';
    end if;
end $$;

revoke all on function public.delete_comment(uuid) from public, anon;
grant execute on function public.delete_comment(uuid) to authenticated;


-- ---------- editing together, live (#21) ----------
-- The owner can let signed-in people with the link edit the board. Opening the
-- link (with its password, if it has one) makes them an editor of that board.
-- Edits travel between everyone on the board over a private Realtime channel
-- named "board:<room>", and each editor saves the whole board through
-- save_live_board(), which keeps the owner's uploaded images (editors never see
-- them). Turning editing off, a new link or a new password removes every editor.
create table if not exists public.board_editors (
    board_owner uuid not null,
    board_id    text not null,
    member      uuid not null default auth.uid() references auth.users (id) on delete cascade,
    joined_at   timestamptz not null default now(),
    primary key (board_owner, board_id, member),
    foreign key (board_owner, board_id) references public.boards (owner, id) on delete cascade
);

alter table public.board_editors enable row level security;
revoke all on public.board_editors from anon, authenticated;

create or replace function public.shares_drop_editors() returns trigger
language plpgsql security definer set search_path = public as $$
begin
    if tg_op = 'DELETE' then
        delete from public.board_editors e where e.board_owner = old.owner and e.board_id = old.board_id;
        return old;
    end if;
    if new.code is distinct from old.code or new.pass_hash is distinct from old.pass_hash or (old.can_edit and not new.can_edit) then
        delete from public.board_editors e where e.board_owner = old.owner and e.board_id = old.board_id;
    end if;
    return new;
end $$;

revoke all on function public.shares_drop_editors() from public, anon, authenticated;

drop trigger if exists shares_drop_editors on public.shares;
create trigger shares_drop_editors after update or delete on public.shares
    for each row execute function public.shares_drop_editors();

-- Internal: the board behind a room, when the caller is its owner or one of its editors.
create or replace function public.live_room(room_id text)
returns table (owner uuid, board_id text)
language sql stable security definer set search_path = public as $$
    select s.owner, s.board_id
      from public.shares s
      join public.boards b on b.owner = s.owner and b.id = s.board_id
     where s.room = room_id and s.can_edit and not b.deleted and auth.uid() is not null
       and (s.owner = auth.uid()
            or exists (select 1 from public.board_editors e
                        where e.board_owner = s.owner and e.board_id = s.board_id and e.member = auth.uid()))
$$;

revoke all on function public.live_room(text) from public, anon, authenticated;

-- May the caller use this room? It only answers yes or no about the caller.
-- The Realtime policies below call it.
create or replace function public.can_use_room(room_id text)
returns boolean language sql stable security definer set search_path = public as $$
    select exists (select 1 from public.live_room(room_id))
$$;

revoke all on function public.can_use_room(text) from public, anon;
grant execute on function public.can_use_room(text) to authenticated;

-- A signed-in visitor opens an edit link. status is share_check()'s, or 'view'
-- when the link is view-only. With 'ok': the room, and the board minus uploads.
create or replace function public.join_board(share_code text, password text default null)
returns table (status text, room text, name text, data jsonb, updated bigint)
language plpgsql volatile security definer set search_path = public, extensions as $$
#variable_conflict use_column
declare
    c record;
    s record;
begin
    if auth.uid() is null then
        raise exception 'sign in to edit';
    end if;
    select * into c from public.share_check(share_code, password);
    if not found then
        return;
    end if;
    if c.status <> 'ok' then
        return query select c.status, null::text, null::text, null::jsonb, null::bigint;
        return;
    end if;
    select sh.room, sh.can_edit into s from public.shares sh where sh.code = share_code;
    if not s.can_edit then
        return query select 'view'::text, null::text, null::text, null::jsonb, null::bigint;
        return;
    end if;
    if c.owner <> auth.uid() then
        insert into public.board_editors (board_owner, board_id, member)
        values (c.owner, c.board_id, auth.uid())
        on conflict do nothing;
    end if;
    return query
        select 'ok'::text, s.room, b.name, public.without_uploads(b.data), b.updated
          from public.boards b
         where b.owner = c.owner and b.id = c.board_id;
end $$;

revoke all on function public.join_board(text, text) from public, anon;
grant execute on function public.join_board(text, text) to authenticated;

-- The board as it is now, for an editor (re)joining the room.
create or replace function public.live_board(room_id text)
returns table (name text, data jsonb, updated bigint)
language sql stable security definer set search_path = public as $$
    select b.name, public.without_uploads(b.data), b.updated
      from public.live_room(room_id) r
      join public.boards b on b.owner = r.owner and b.id = r.board_id
$$;

revoke all on function public.live_board(text) from public, anon;
grant execute on function public.live_board(text) to authenticated;

-- An editor saves the whole board. The owner's uploaded images, and the threads
-- tied to them, are kept from the stored copy, since editors never see them.
-- Returns the board's new `updated`, always later than the stored one.
create or replace function public.save_live_board(room_id text, board jsonb, edited bigint)
returns bigint language plpgsql volatile security definer set search_path = public as $$
declare
    r record;
    cur jsonb;
    prev bigint;
    ups jsonb;
    up_ids text[];
    next_pins jsonb;
    next_threads jsonb;
    next_name text;
    next_updated bigint;
begin
    if auth.uid() is null then
        raise exception 'sign in to edit';
    end if;
    select * into r from public.live_room(room_id);
    if not found then
        raise exception 'not allowed';
    end if;
    if jsonb_typeof(board) <> 'object' then
        raise exception 'not a board';
    end if;
    select b.data, b.updated into cur, prev
      from public.boards b
     where b.owner = r.owner and b.id = r.board_id
       for update;

    select coalesce(jsonb_agg(p), '[]'::jsonb) into ups
      from jsonb_array_elements(case when jsonb_typeof(cur -> 'pins') = 'array' then cur -> 'pins' else '[]'::jsonb end) p
     where p ->> 'kind' = 'upload';
    select coalesce(array_agg(p ->> 'id'), '{}') into up_ids from jsonb_array_elements(ups) p;

    select coalesce(jsonb_agg(p), '[]'::jsonb) || ups into next_pins
      from jsonb_array_elements(case when jsonb_typeof(board -> 'pins') = 'array' then board -> 'pins' else '[]'::jsonb end) p
     where p ->> 'kind' is distinct from 'upload';
    select coalesce(jsonb_agg(x.t), '[]'::jsonb) into next_threads
      from (
        select t from jsonb_array_elements(case when jsonb_typeof(board -> 'threads') = 'array' then board -> 'threads' else '[]'::jsonb end) t
        union all
        select t from jsonb_array_elements(case when jsonb_typeof(cur -> 'threads') = 'array' then cur -> 'threads' else '[]'::jsonb end) t
         where t ->> 'a' = any (up_ids) or t ->> 'b' = any (up_ids)
      ) x;

    next_name := left(btrim(coalesce(board ->> 'name', '')), 60);
    if next_name = '' then
        next_name := coalesce(cur ->> 'name', 'Shared board');
    end if;
    next_updated := greatest(coalesce(edited, 0), coalesce(prev, 0) + 1);

    update public.boards b
       set data = board || jsonb_build_object('name', next_name, 'pins', next_pins, 'threads', next_threads),
           name = next_name,
           updated = next_updated
     where b.owner = r.owner and b.id = r.board_id;
    return next_updated;
end $$;

revoke all on function public.save_live_board(text, jsonb, bigint) from public, anon;
grant execute on function public.save_live_board(text, jsonb, bigint) to authenticated;

-- Realtime: only the owner and editors can listen or send on "board:<room>".
-- Private channels must be enforced for this to hold: Realtime → Settings →
-- turn off "Allow public access" (README → Accounts).
drop policy if exists "live: editors listen" on realtime.messages;
drop policy if exists "live: editors send"   on realtime.messages;

create policy "live: editors listen" on realtime.messages for select to authenticated
    using (realtime.messages.extension in ('broadcast', 'presence')
           and realtime.topic() like 'board:%'
           and public.can_use_room(substring(realtime.topic() from 7)));
create policy "live: editors send" on realtime.messages for insert to authenticated
    with check (realtime.messages.extension in ('broadcast', 'presence')
                and realtime.topic() like 'board:%'
                and public.can_use_room(substring(realtime.topic() from 7)));
