-- Receipt stats for the owner-only App stats page.
-- Counts only: how many receipts were uploaded and how many automatic readings worked or failed.
-- Nothing about what was on a receipt, and nothing per family or per person.
-- Needs 007 (receipt_scans). Run in Supabase -> SQL Editor. Safe to run twice.

-- 1. Remember how each reading ended (still no image and no content). Older rows stay null = "unknown".
alter table public.receipt_scans add column if not exists outcome text;
alter table public.receipt_scans drop constraint if exists receipt_scans_outcome_check;
alter table public.receipt_scans add constraint receipt_scans_outcome_check
  check (outcome is null or outcome in ('pending', 'read', 'not_receipt', 'unreadable', 'error'));

-- 2. Keep 90 days of history for the stats (limits still only look at the last 24 hours).
--    Same behaviour as before otherwise: returns 'ok', 'user_limit' or 'global_limit'.
create or replace function public.claim_receipt_scan(p_user uuid, p_user_limit int, p_global_limit int)
returns text language plpgsql security definer set search_path = public as $$
declare mine int; everyone int;
begin
  perform pg_advisory_xact_lock(hashtext('receipt_scans'));
  select count(*) into mine from receipt_scans where user_id = p_user and scanned_at > now() - interval '24 hours';
  if mine >= p_user_limit then return 'user_limit'; end if;
  select count(*) into everyone from receipt_scans where scanned_at > now() - interval '24 hours';
  if everyone >= p_global_limit then return 'global_limit'; end if;
  insert into receipt_scans (user_id, outcome) values (p_user, 'pending');
  delete from receipt_scans where scanned_at < now() - interval '90 days';
  return 'ok';
end $$;
revoke all on function public.claim_receipt_scan(uuid, int, int) from public, anon, authenticated;
grant execute on function public.claim_receipt_scan(uuid, int, int) to service_role;

-- 3. The server-side function reports how the person's latest reading ended.
create or replace function public.finish_receipt_scan(p_user uuid, p_outcome text)
returns void language sql security definer set search_path = public as $$
  update receipt_scans set outcome = p_outcome
  where id = (select id from receipt_scans where user_id = p_user and outcome = 'pending'
              order by scanned_at desc, id desc limit 1)
    and p_outcome in ('read', 'not_receipt', 'unreadable', 'error');
$$;
revoke all on function public.finish_receipt_scan(uuid, text) from public, anon, authenticated;
grant execute on function public.finish_receipt_scan(uuid, text) to service_role;

-- 4. Owner-only totals for the App stats page.
create or replace function public.owner_receipt_stats()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  result jsonb;
  cost_per_reading constant numeric := 0.01; -- rough US$ per reading; adjust if the real bill differs
begin
  if not public.is_app_owner() then
    raise exception 'Not allowed' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'uploaded', jsonb_build_object(
      'total', (select count(*) from public.expenses where receipt_path is not null),
      'new_7d', (select count(*) from public.expenses where receipt_path is not null and created_at > now() - interval '7 days'),
      'new_30d', (select count(*) from public.expenses where receipt_path is not null and created_at > now() - interval '30 days')
    ),
    'readings', jsonb_build_object(
      'total', (select count(*) from public.receipt_scans),
      'read_ok', (select count(*) from public.receipt_scans where outcome = 'read'),
      'not_receipt', (select count(*) from public.receipt_scans where outcome = 'not_receipt'),
      'failed', (select count(*) from public.receipt_scans where outcome in ('unreadable', 'error')),
      'unknown', (select count(*) from public.receipt_scans where outcome is null or outcome = 'pending'),
      'today', (select count(*) from public.receipt_scans where scanned_at > now() - interval '24 hours'),
      'new_7d', (select count(*) from public.receipt_scans where scanned_at > now() - interval '7 days'),
      'new_30d', (select count(*) from public.receipt_scans where scanned_at > now() - interval '30 days'),
      'est_cost_usd_30d', (select round(count(*) * cost_per_reading, 2) from public.receipt_scans
                           where scanned_at > now() - interval '30 days' and coalesce(outcome, 'read') <> 'error'),
      'est_cost_usd_total', (select round(count(*) * cost_per_reading, 2) from public.receipt_scans
                             where coalesce(outcome, 'read') <> 'error'),
      'cost_per_reading_usd', cost_per_reading
    ),
    'daily', (
      select jsonb_agg(jsonb_build_object(
        'day', to_char(d.day, 'YYYY-MM-DD'),
        'readings', (select count(*) from public.receipt_scans s where s.scanned_at >= d.day and s.scanned_at < d.day + interval '1 day'),
        'failed', (select count(*) from public.receipt_scans s where s.scanned_at >= d.day and s.scanned_at < d.day + interval '1 day'
                   and s.outcome in ('unreadable', 'error'))
      ) order by d.day)
      from generate_series(date_trunc('day', now()) - interval '13 days', date_trunc('day', now()), interval '1 day') as d(day)
    )
  ) into result;
  return result;
end;
$$;
revoke execute on function public.owner_receipt_stats() from public, anon;
grant execute on function public.owner_receipt_stats() to authenticated;
