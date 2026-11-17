-- Automatic receipt reading: a simple log used ONLY to enforce daily limits (keeps the AI bill predictable).
-- It stores who scanned and when. It never stores the receipt image or what was read from it.
-- Run in Supabase -> SQL Editor. Safe to run twice.

create table if not exists public.receipt_scans (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  scanned_at  timestamptz not null default now()
);
create index if not exists receipt_scans_user_time on public.receipt_scans (user_id, scanned_at desc);
create index if not exists receipt_scans_time on public.receipt_scans (scanned_at desc);

-- Locked down: only the server-side function (service role) can touch it.
alter table public.receipt_scans enable row level security;
revoke all on public.receipt_scans from anon, authenticated;

-- Atomically checks the limits and, if there is room, records one scan.
-- Returns 'ok', 'user_limit' (this person hit their daily cap) or 'global_limit' (everyone's daily cap).
create or replace function public.claim_receipt_scan(p_user uuid, p_user_limit int, p_global_limit int)
returns text language plpgsql security definer set search_path = public as $$
declare mine int; everyone int;
begin
  perform pg_advisory_xact_lock(hashtext('receipt_scans'));
  select count(*) into mine from receipt_scans where user_id = p_user and scanned_at > now() - interval '24 hours';
  if mine >= p_user_limit then return 'user_limit'; end if;
  select count(*) into everyone from receipt_scans where scanned_at > now() - interval '24 hours';
  if everyone >= p_global_limit then return 'global_limit'; end if;
  insert into receipt_scans (user_id) values (p_user);
  delete from receipt_scans where scanned_at < now() - interval '7 days';
  return 'ok';
end $$;
revoke all on function public.claim_receipt_scan(uuid, int, int) from public, anon, authenticated;
grant execute on function public.claim_receipt_scan(uuid, int, int) to service_role;
