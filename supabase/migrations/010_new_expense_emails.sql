-- "Email me when someone in my family adds an expense": an opt-in switch, off by default.
-- Builds on 005 (email_prefs). Safe to run more than once.
-- Paste into Supabase: SQL Editor -> New query -> Run.

-- 1. The switch lives next to the monthly-summary switch. No row / false = off.
alter table public.email_prefs add column if not exists new_expense_alerts boolean not null default false;

-- 2. Which expenses we already emailed about, so an expense is never announced twice.
create table if not exists public.expense_alert_log (
  expense_id uuid primary key references public.expenses (id) on delete cascade,
  sent_at    timestamptz not null default now()
);
alter table public.expense_alert_log enable row level security;
revoke all on public.expense_alert_log from anon, authenticated;

-- 3. The Account page switch: read it ...
create or replace function public.get_expense_alerts()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce((select new_expense_alerts from public.email_prefs where user_id = auth.uid()), false);
$$;

-- ... and change it (only ever your own).
create or replace function public.set_expense_alerts(enabled boolean)
returns boolean
language plpgsql security definer set search_path = ''
as $$
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  insert into public.email_prefs (user_id, new_expense_alerts) values (auth.uid(), enabled)
  on conflict (user_id) do update set new_expense_alerts = excluded.new_expense_alerts, updated_at = now();
  return enabled;
end;
$$;

-- 4. The unsubscribe link in each alert email (works without logging in).
create or replace function public.unsubscribe_expense_alerts_by_token(t text)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if t is null or t !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return; end if;
  update public.email_prefs set new_expense_alerts = false, updated_at = now() where unsub_token = t::uuid;
end;
$$;

-- 5. What the email function reads. Only the server-side service key may call it.
-- It only answers for a brand-new expense (last 15 minutes) that p_actor created, claims it so
-- it is announced once, and returns the OTHER active family members who switched alerts on.
-- Returns null when there is nothing to send.
create or replace function public.expense_alert_payload(p_expense uuid, p_actor uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare e record; claimed int; result jsonb;
begin
  select ex.id, ex.family_id, ex.amount_cents, ex.spent_on, ex.category, ex.description
    into e from public.expenses ex
   where ex.id = p_expense and ex.created_by = p_actor and ex.created_at > now() - interval '15 minutes';
  if not found then return null; end if;

  insert into public.expense_alert_log (expense_id) values (e.id) on conflict do nothing;
  get diagnostics claimed = row_count;
  if claimed = 0 then return null; end if;

  select jsonb_build_object(
    'family_name', fam.name,
    'actor_name', coalesce((select m.display_name from public.family_members m
                            where m.family_id = e.family_id and m.user_id = p_actor), 'Someone in your family'),
    'amount_cents', e.amount_cents, 'spent_on', e.spent_on, 'category', e.category,
    'description', e.description,
    'recipients', coalesce((
      select jsonb_agg(jsonb_build_object('email', u.email, 'unsub_token', p.unsub_token))
      from public.family_members m
      join public.email_prefs p on p.user_id = m.user_id and p.new_expense_alerts
      join auth.users u on u.id = m.user_id
      where m.family_id = e.family_id and m.left_at is null and m.user_id <> p_actor
        and u.email is not null and u.email_confirmed_at is not null), '[]'::jsonb))
  into result
  from public.families fam where fam.id = e.family_id;
  return result;
end;
$$;

revoke execute on function public.get_expense_alerts(), public.set_expense_alerts(boolean),
  public.unsubscribe_expense_alerts_by_token(text), public.expense_alert_payload(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.get_expense_alerts(), public.set_expense_alerts(boolean) to authenticated;
grant execute on function public.unsubscribe_expense_alerts_by_token(text) to anon, authenticated;
grant execute on function public.expense_alert_payload(uuid, uuid) to service_role;
