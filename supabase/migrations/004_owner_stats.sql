-- SiblingTab update 4: a private stats page for the app's owner.
-- Counts only: no names, emails, family names, amounts per family or receipts.
-- Run once in Supabase: SQL Editor -> New query -> paste -> Run.
--
-- Then make yourself the owner with ONE extra line (put your own login email in it):
--   insert into public.app_owners (user_id) select id from auth.users where email = 'you@example.com';

create table if not exists public.app_owners (
  user_id uuid primary key
);
alter table public.app_owners enable row level security;
-- No policies and no grants: nobody can read or change this list from the app.
revoke all on public.app_owners from anon, authenticated;

create or replace function public.is_app_owner()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.app_owners where user_id = auth.uid());
$$;

create or replace function public.owner_stats()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  result jsonb;
begin
  if not public.is_app_owner() then
    raise exception 'Not allowed' using errcode = '42501';
  end if;

  with
  weeks as (
    select generate_series(date_trunc('week', now()) - interval '7 weeks', date_trunc('week', now()), interval '1 week') as wk
  ),
  active_people as (
    select created_by as uid, created_at from public.expenses
    union all
    select created_by, created_at from public.settlements
  ),
  fam_sizes as (
    select f.id, count(m.user_id) filter (where m.left_at is null) as active_members
    from public.families f left join public.family_members m on m.family_id = f.id
    group by f.id
  )
  select jsonb_build_object(
    'generated_at', now(),
    'accounts', jsonb_build_object(
      'total', (select count(*) from auth.users),
      'confirmed', (select count(*) from auth.users where email_confirmed_at is not null),
      'new_7d', (select count(*) from auth.users where created_at > now() - interval '7 days'),
      'new_30d', (select count(*) from auth.users where created_at > now() - interval '30 days'),
      'signed_in_7d', (select count(*) from auth.users where last_sign_in_at > now() - interval '7 days'),
      'signed_in_30d', (select count(*) from auth.users where last_sign_in_at > now() - interval '30 days'),
      'no_family', (select count(*) from auth.users u
                    where not exists (select 1 from public.family_members m where m.user_id = u.id and m.left_at is null))
    ),
    'families', jsonb_build_object(
      'total', (select count(*) from fam_sizes),
      'with_2_plus', (select count(*) from fam_sizes where active_members >= 2),
      'avg_members', (select round(avg(active_members), 1) from fam_sizes),
      'active_7d', (select count(distinct family_id) from public.expenses where created_at > now() - interval '7 days'),
      'active_30d', (select count(distinct family_id) from public.expenses where created_at > now() - interval '30 days')
    ),
    'members', jsonb_build_object(
      'active', (select count(*) from public.family_members where left_at is null),
      'former', (select count(*) from public.family_members where left_at is not null)
    ),
    'expenses', jsonb_build_object(
      'total', (select count(*) from public.expenses),
      'with_receipt', (select count(*) from public.expenses where receipt_path is not null),
      'new_7d', (select count(*) from public.expenses where created_at > now() - interval '7 days'),
      'new_30d', (select count(*) from public.expenses where created_at > now() - interval '30 days'),
      'total_cents', (select coalesce(sum(amount_cents), 0) from public.expenses)
    ),
    'paybacks', jsonb_build_object(
      'total', (select count(*) from public.settlements),
      'new_30d', (select count(*) from public.settlements where created_at > now() - interval '30 days')
    ),
    'people_adding_7d', (select count(distinct uid) from active_people where created_at > now() - interval '7 days'),
    'people_adding_30d', (select count(distinct uid) from active_people where created_at > now() - interval '30 days'),
    'weekly', (
      select jsonb_agg(jsonb_build_object(
        'week', to_char(w.wk, 'YYYY-MM-DD'),
        'accounts', (select count(*) from auth.users where created_at >= w.wk and created_at < w.wk + interval '1 week'),
        'families', (select count(*) from public.families where created_at >= w.wk and created_at < w.wk + interval '1 week'),
        'expenses', (select count(*) from public.expenses where created_at >= w.wk and created_at < w.wk + interval '1 week')
      ) order by w.wk)
      from weeks w
    )
  ) into result;
  return result;
end;
$$;

revoke execute on function public.is_app_owner(), public.owner_stats() from public, anon;
grant execute on function public.is_app_owner(), public.owner_stats() to authenticated;
