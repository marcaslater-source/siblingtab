-- Turns the monthly email ON: asks the "monthly-summary" function to run at 13:00 UTC
-- (8 or 9 AM Toronto) on the 1st of every month. Run this ONLY after the function is
-- deployed and you've checked a dry run. See MONTHLY-EMAIL.md for the steps.
--
-- Before running: replace PASTE_YOUR_SECRET_HERE below with the same secret you saved
-- as CRON_SECRET in the function's settings (two places in this file: just the first line).

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Save the secret where only the database can read it.
select vault.create_secret('PASTE_YOUR_SECRET_HERE', 'monthly_email_secret')
where not exists (select 1 from vault.secrets where name = 'monthly_email_secret');

select cron.schedule(
  'monthly-summary-email',
  '0 13 1 * *',
  $$
  select net.http_post(
    url := 'https://oeoztluulroglfbvwyon.supabase.co/functions/v1/monthly-summary',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'monthly_email_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000);
  $$);

-- To turn it OFF later:  select cron.unschedule('monthly-summary-email');
