# Monthly summary email: how to turn it on

What it does: on the 1st of each month, each person who switched it on (Account page, off by default)
gets one email with last month's totals for their own family: who covered what, a simple way to even
things out, and receipts still to add. Every email has an unsubscribe link.

## Steps (in this order)
1. **Database.** Supabase -> SQL Editor -> New query. Paste `supabase/migrations/005_monthly_summary_email.sql`, Run.
2. **Upload the app.** Upload `siblingtab-app-upload.zip` to `app.siblingtab.com` folder in SiteGround File Manager,
   extract, then Speed -> Caching -> Dynamic Cache -> Flush. (Switch appears on the Account page.)
3. **The email function.** Supabase -> Edge Functions -> Deploy a new function -> name it `monthly-summary`,
   paste in `supabase/functions/monthly-summary/index.ts`, and turn **Verify JWT** OFF (our own secret protects it).
4. **Function secrets** (Edge Functions -> Secrets): `CRON_SECRET` (any long random string; SQL Editor
   `select gen_random_uuid()` makes one), `SMTP_HOST`, `SMTP_PORT` (465), `SMTP_USER` (noreply@siblingtab.com),
   `SMTP_PASS` (the same mailbox details as Authentication -> Emails -> SMTP Settings).
5. **Preview (sends nothing).** Call the function with `{"dry_run": true}` (Edge Functions -> monthly-summary -> Test,
   header `x-cron-secret: <your secret>`). You get the exact emails it would send.
6. **Send one test to yourself.** Switch the toggle on in your own account, then call with
   `{"only_email": "you@...", "month": "2026-10"}`.
7. **Turn the monthly schedule on.** Paste `supabase/migrations/006_schedule_monthly_email.sql`, replacing
   `PASTE_YOUR_SECRET_HERE` with your CRON_SECRET, Run. To stop it: `select cron.unschedule('monthly-summary-email');`

Re-running a month never double-sends (each person/month is logged).
