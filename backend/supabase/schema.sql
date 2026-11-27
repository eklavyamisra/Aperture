-- Aperture: accounts, synced boards and uploaded images (roadmap #15–17).
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
