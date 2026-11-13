-- Monthly summary email: who opted in, the unsubscribe link, and the data the email job reads.
-- Safe to run more than once. Paste into Supabase: SQL Editor -> New query -> Run.

-- One row per person who has ever touched the switch. No row = switched off.
create table if not exists public.email_prefs (
  user_id         uuid primary key references auth.users (id) on delete cascade,
  monthly_summary boolean not null default false,
  unsub_token     uuid not null default gen_random_uuid() unique,
  updated_at      timestamptz not null default now()
);
alter table public.email_prefs enable row level security;
revoke all on public.email_prefs from anon, authenticated;   -- only the functions below can touch it

-- Which months we already emailed to whom, so running the job twice never double-sends.
create table if not exists public.email_log (
  user_id uuid not null references auth.users (id) on delete cascade,
  month   date not null,
  sent_at timestamptz not null default now(),
  primary key (user_id, month)
);
alter table public.email_log enable row level security;
revoke all on public.email_log from anon, authenticated;

-- The Account page switch: read it ...
create or replace function public.get_monthly_summary()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce((select monthly_summary from public.email_prefs where user_id = auth.uid()), false);
$$;

-- ... and change it (only ever your own).
create or replace function public.set_monthly_summary(enabled boolean)
returns boolean
language plpgsql security definer set search_path = ''
as $$
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  insert into public.email_prefs (user_id, monthly_summary) values (auth.uid(), enabled)
  on conflict (user_id) do update set monthly_summary = excluded.monthly_summary, updated_at = now();
  return enabled;
end;
$$;

-- The unsubscribe link in each email. Works without logging in; the long random
-- token in the link is the proof. Says nothing about whether the token was valid.
create or replace function public.unsubscribe_by_token(t text)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if t is null or t !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return; end if;
  update public.email_prefs set monthly_summary = false, updated_at = now() where unsub_token = t::uuid;
end;
$$;

-- What the email job reads. Only the server-side service key may call it.
-- Each person only ever gets rows from families they are an active member of.
-- p_start / p_end: first day of the month and first day of the next month.
create or replace function public.monthly_summary_payloads(
  p_start date, p_end date, p_only_email text default null)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare result jsonb;
begin
  with recipients as (
    select u.id as user_id, u.email, p.unsub_token
    from public.email_prefs p
    join auth.users u on u.id = p.user_id
    where p.monthly_summary
      and u.email is not null and u.email_confirmed_at is not null
      and not exists (select 1 from public.email_log l where l.user_id = u.id and l.month = p_start)
      and (p_only_email is null or lower(u.email) = lower(p_only_email))
  ),
  fams as (   -- families each recipient is an active member of
    select r.user_id, m.family_id, m.display_name as my_name
    from recipients r
    join public.family_members m on m.user_id = r.user_id and m.left_at is null
  ),
  fam_data as (
    select f.user_id, f.my_name, fam.id as family_id, fam.name as family_name,
      (select coalesce(jsonb_agg(jsonb_build_object(
          'id', m.user_id,
          'name', case when m.left_at is null then m.display_name else 'Former member' end,
          'active', m.left_at is null) order by m.joined_at, m.user_id), '[]'::jsonb)
         from public.family_members m where m.family_id = fam.id) as members,
      (select coalesce(sum(e.amount_cents), 0) from public.expenses e
        where e.family_id = fam.id and e.spent_on >= p_start and e.spent_on < p_end) as total_cents,
      (select count(*) from public.expenses e
        where e.family_id = fam.id and e.spent_on >= p_start and e.spent_on < p_end) as expense_count,
      (select coalesce(jsonb_object_agg(x.paid_by, x.c), '{}'::jsonb) from (
          select e.paid_by, sum(e.amount_cents) as c from public.expenses e
          where e.family_id = fam.id and e.spent_on >= p_start and e.spent_on < p_end
          group by e.paid_by) x) as paid,
      (select count(*) from public.expenses e
        where e.family_id = fam.id and e.spent_on >= p_start and e.spent_on < p_end
          and e.receipt_path is null) as missing_count,
      (select coalesce(jsonb_agg(jsonb_build_object(
            'spent_on', y.spent_on, 'description', y.description,
            'category', y.category, 'amount_cents', y.amount_cents)
          order by y.spent_on, y.created_at), '[]'::jsonb) from (
          select e.spent_on, e.description, e.category, e.amount_cents, e.created_at
          from public.expenses e
          where e.family_id = fam.id and e.spent_on >= p_start and e.spent_on < p_end
            and e.receipt_path is null
          order by e.spent_on, e.created_at limit 10) y) as missing,
      (select coalesce(sum(s.amount_cents), 0) from public.settlements s
        where s.family_id = fam.id and s.settled_on >= p_start and s.settled_on < p_end) as paid_back_cents,
      -- Balance up to the end of the month: paid - share + payments sent - payments received.
      (select coalesce(jsonb_object_agg(n.uid, n.net), '{}'::jsonb) from (
          select m.user_id as uid,
            coalesce((select sum(e.amount_cents) from public.expenses e
                      where e.family_id = fam.id and e.paid_by = m.user_id and e.spent_on < p_end), 0)
          - coalesce((select sum(sh.share_cents) from public.expense_shares sh
                      join public.expenses e on e.id = sh.expense_id
                      where sh.family_id = fam.id and sh.user_id = m.user_id and e.spent_on < p_end), 0)
          + coalesce((select sum(s.amount_cents) from public.settlements s
                      where s.family_id = fam.id and s.from_user = m.user_id and s.settled_on < p_end), 0)
          - coalesce((select sum(s.amount_cents) from public.settlements s
                      where s.family_id = fam.id and s.to_user = m.user_id and s.settled_on < p_end), 0) as net
          from public.family_members m where m.family_id = fam.id) n) as net
    from fams f
    join public.families fam on fam.id = f.family_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'user_id', r.user_id, 'email', r.email, 'unsub_token', r.unsub_token,
      'name', (select d.my_name from fam_data d where d.user_id = r.user_id order by d.family_name limit 1),
      'families', (select jsonb_agg(jsonb_build_object(
          'family_id', d.family_id, 'name', d.family_name, 'members', d.members,
          'total_cents', d.total_cents, 'expense_count', d.expense_count, 'paid', d.paid,
          'missing_count', d.missing_count, 'missing', d.missing,
          'paid_back_cents', d.paid_back_cents, 'net', d.net) order by d.family_name, d.family_id)
        from fam_data d where d.user_id = r.user_id)
    )), '[]'::jsonb)
  into result
  from recipients r
  where exists (select 1 from fam_data d where d.user_id = r.user_id);
  return result;
end;
$$;

create or replace function public.mark_summary_sent(p_user uuid, p_start date)
returns void
language sql security definer set search_path = ''
as $$
  insert into public.email_log (user_id, month) values (p_user, p_start) on conflict do nothing;
$$;

revoke execute on function public.get_monthly_summary(), public.set_monthly_summary(boolean),
  public.unsubscribe_by_token(text), public.monthly_summary_payloads(date, date, text),
  public.mark_summary_sent(uuid, date) from public, anon, authenticated;
grant execute on function public.get_monthly_summary(), public.set_monthly_summary(boolean)
  to authenticated;
grant execute on function public.unsubscribe_by_token(text) to anon, authenticated;
grant execute on function public.monthly_summary_payloads(date, date, text),
  public.mark_summary_sent(uuid, date) to service_role;
