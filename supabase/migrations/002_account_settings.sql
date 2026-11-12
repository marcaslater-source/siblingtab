-- SiblingTab update 2: account settings (profile photo, delete my account).
-- Run once in Supabase: SQL Editor -> New query -> paste -> Run.
-- Safe to run on a database that already has schema.sql.

-- ---------------------------------------------------------------------------
-- 1. Let a person's account be deleted while keeping the family's shared records.
--    Expenses and paybacks stay (the family still needs them for its totals),
--    but the person's name becomes "Former member" and their login is removed.
--    For that, these columns must no longer require a matching login.
-- ---------------------------------------------------------------------------

alter table public.families       drop constraint if exists families_created_by_fkey;
alter table public.family_members drop constraint if exists family_members_user_id_fkey;
alter table public.invites        drop constraint if exists invites_created_by_fkey;
alter table public.expenses       drop constraint if exists expenses_created_by_fkey;
alter table public.settlements    drop constraint if exists settlements_created_by_fkey;

alter table public.family_members add column if not exists left_at timestamptz;

-- Former members can't be picked as the payer or a sharer of new expenses.
create or replace function public.is_active_member(fid uuid, uid uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.family_members m
    where m.family_id = fid and m.user_id = uid and m.left_at is null
  );
$$;

-- ---------------------------------------------------------------------------
-- 2. Profiles: one row per person, holding their profile photo.
-- ---------------------------------------------------------------------------

create table if not exists public.profiles (
  id          uuid primary key,
  avatar_path text check (avatar_path is null or char_length(avatar_path) <= 200),
  updated_at  timestamptz not null default now()
);
alter table public.profiles enable row level security;

-- Do two people share a family? (Used to let siblings see each other's photos.)
create or replace function public.shares_family(other uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select other = auth.uid() or exists (
    select 1
    from public.family_members a
    join public.family_members b on a.family_id = b.family_id
    where a.user_id = auth.uid() and a.left_at is null
      and b.user_id = other
  );
$$;

drop policy if exists "see own and siblings' profiles" on public.profiles;
create policy "see own and siblings' profiles" on public.profiles
  for select to authenticated using (public.shares_family(id));
drop policy if exists "create own profile" on public.profiles;
create policy "create own profile" on public.profiles
  for insert to authenticated with check (id = auth.uid());
drop policy if exists "edit own profile" on public.profiles;
create policy "edit own profile" on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

revoke all on public.profiles from anon, authenticated;
grant select, insert on public.profiles to authenticated;
grant update (avatar_path, updated_at) on public.profiles to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Profile photo storage: private bucket, files under "<user id>/...".
--    You can change your own photo; you can see photos of people in your families.
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', false, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

create or replace function public.avatar_owner(path text)
returns uuid
language sql immutable set search_path = ''
as $$
  select case
    when split_part(path, '/', 1) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then split_part(path, '/', 1)::uuid
  end;
$$;

drop policy if exists "see family avatars" on storage.objects;
create policy "see family avatars" on storage.objects
  for select to authenticated
  using (bucket_id = 'avatars' and public.shares_family(public.avatar_owner(name)));
drop policy if exists "upload own avatar" on storage.objects;
create policy "upload own avatar" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'avatars' and public.avatar_owner(name) = auth.uid());
drop policy if exists "replace own avatar" on storage.objects;
create policy "replace own avatar" on storage.objects
  for update to authenticated
  using (bucket_id = 'avatars' and public.avatar_owner(name) = auth.uid())
  with check (bucket_id = 'avatars' and public.avatar_owner(name) = auth.uid());
drop policy if exists "delete own avatar" on storage.objects;
create policy "delete own avatar" on storage.objects
  for delete to authenticated
  using (bucket_id = 'avatars' and public.avatar_owner(name) = auth.uid());

-- ---------------------------------------------------------------------------
-- 4. Stop former members being picked as the payer of new expenses.
--    (Old expenses they shared can still be edited, and paybacks with them
--    can still be recorded so the family can settle up.)
-- ---------------------------------------------------------------------------

drop policy if exists "members add expenses" on public.expenses;
create policy "members add expenses" on public.expenses
  for insert to authenticated with check (
    public.is_member(family_id) and created_by = auth.uid()
    and public.is_active_member(family_id, paid_by));

-- ---------------------------------------------------------------------------
-- 5. Delete my account.
--    - Families where you're the only member are deleted completely.
--    - In shared families, your name becomes "Former member"; the family keeps
--      its expense history so totals stay right.
--    - Your profile and login are removed.
--    The app deletes your photo and the receipts of families being removed
--    from storage first, because files can't be removed from inside the database.
-- ---------------------------------------------------------------------------

create or replace function public.delete_my_account()
returns void
language plpgsql security definer set search_path = ''
as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'Not signed in'; end if;

  delete from public.families f
  where exists (select 1 from public.family_members m where m.family_id = f.id and m.user_id = me)
    and not exists (select 1 from public.family_members m
                    where m.family_id = f.id and m.user_id <> me and m.left_at is null);

  update public.family_members
     set display_name = 'Former member', left_at = coalesce(left_at, now())
   where user_id = me;

  delete from public.invites where created_by = me;
  delete from public.profiles where id = me;
  delete from auth.users where id = me;
end;
$$;

-- Lists the families that delete_my_account() would remove entirely,
-- so the app can clear their receipt photos first.
create or replace function public.families_deleted_with_me()
returns setof uuid
language sql stable security definer set search_path = ''
as $$
  select f.id from public.families f
  where exists (select 1 from public.family_members m where m.family_id = f.id and m.user_id = auth.uid())
    and not exists (select 1 from public.family_members m
                    where m.family_id = f.id and m.user_id <> auth.uid() and m.left_at is null);
$$;

revoke execute on function public.is_active_member(uuid, uuid), public.shares_family(uuid),
  public.avatar_owner(text), public.delete_my_account(), public.families_deleted_with_me()
  from public, anon;
grant execute on function public.is_active_member(uuid, uuid), public.shares_family(uuid),
  public.avatar_owner(text), public.delete_my_account(), public.families_deleted_with_me()
  to authenticated;
