-- Billing (Stripe subscriptions), one row per family. Run in Supabase: SQL Editor -> New query -> Run.
-- Family members can READ their family's plan status. Nobody can write from the app:
-- only the two Stripe functions (using the service key) fill this in.

create table if not exists public.family_billing (
  family_id              uuid primary key references public.families (id) on delete cascade,
  stripe_customer_id     text unique,
  stripe_subscription_id text unique,
  status                 text not null default 'none',   -- none, trialing, active, past_due, canceled, ...
  trial_end              timestamptz,
  current_period_end     timestamptz,
  cancel_at_period_end   boolean not null default false,
  updated_at             timestamptz not null default now()
);

alter table public.family_billing enable row level security;

create policy "members read billing" on public.family_billing
  for select to authenticated using (public.is_member(family_id));

revoke all on public.family_billing from anon, authenticated;
grant select on public.family_billing to authenticated;
