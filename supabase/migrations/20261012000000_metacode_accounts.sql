-- MetaCode accounts: each signed-in user's data, kept in Supabase.
--
-- Run once in the Supabase dashboard (SQL Editor → New query → paste → Run), or
-- with the Supabase CLI (`supabase db push`). Safe to run again.
--
-- The browser talks to this table directly with the project's publishable key
-- and the user's session. Row Level Security is what keeps people apart: every
-- policy below allows a row only when its user_id is the signed-in user
-- (auth.uid()), so nobody can read, change or delete anyone else's data — not
-- even with the publishable key, which is public by design.
--
-- What's stored (public/js/cloud-sync.js):
--   kind 'workspace'  the open project (posts, codes, codebook, network, settings)
--   kind 'projects'   saved projects (Projects page)
--   kind 'surveys'    Survey Studio drafts
--   kind 'meta'       the Survey Studio library and other small things
-- API keys typed into MetaCode (Reddit, RedditAPIs.com) are never synced.
-- Plans, usage and billing are not here: the MetaCode server keeps those and
-- gets plans from Stripe, so nothing in this table can change what a user may do.

create table if not exists public.metacode_data (
  user_id    uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  kind       text        not null check (kind in ('workspace', 'projects', 'surveys', 'meta')),
  id         text        not null check (char_length(id) between 1 and 200),
  data       jsonb,
  deleted    boolean     not null default false,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  primary key (user_id, kind, id),
  -- one record at most ~25 MB (large projects with many posts)
  constraint metacode_data_size check (data is null or pg_column_size(data) <= 26214400)
);

create index if not exists metacode_data_user_updated on public.metacode_data (user_id, updated_at);

alter table public.metacode_data enable row level security;

drop policy if exists "metacode_data: read own"   on public.metacode_data;
drop policy if exists "metacode_data: insert own" on public.metacode_data;
drop policy if exists "metacode_data: update own" on public.metacode_data;
drop policy if exists "metacode_data: delete own" on public.metacode_data;
create policy "metacode_data: read own"   on public.metacode_data for select to authenticated using ((select auth.uid()) = user_id);
create policy "metacode_data: insert own" on public.metacode_data for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "metacode_data: update own" on public.metacode_data for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "metacode_data: delete own" on public.metacode_data for delete to authenticated using ((select auth.uid()) = user_id);

-- Anonymous visitors get nothing; signed-in users get only what the policies allow.
revoke all on public.metacode_data from anon;
grant select, insert, update, delete on public.metacode_data to authenticated;

-- The server's clock decides the order of changes (devices' clocks may be off),
-- and a row's owner can't be changed.
create or replace function public.metacode_data_touch() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  if tg_op = 'UPDATE' then
    new.user_id := old.user_id;
    new.created_at := old.created_at;
  end if;
  return new;
end $$;

drop trigger if exists metacode_data_touch on public.metacode_data;
create trigger metacode_data_touch before insert or update on public.metacode_data
  for each row execute function public.metacode_data_touch();

-- At most 5,000 records per account (abuse protection; real use is far below).
create or replace function public.metacode_data_cap() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select count(*) from public.metacode_data where user_id = new.user_id) >= 5000 then
    raise exception 'This account has too many saved items (5,000 at most).' using errcode = 'P0001';
  end if;
  return new;
end $$;

drop trigger if exists metacode_data_cap on public.metacode_data;
create trigger metacode_data_cap before insert on public.metacode_data
  for each row execute function public.metacode_data_cap();
