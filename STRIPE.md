# Stripe billing (test mode first)

SiblingTab uses **Stripe Billing with Checkout**, not Stripe Connect: families pay SiblingTab a subscription,
and no money moves between siblings. Defaults: $8 CAD/month, 14-day free trial, one plan per family,
managed by the person who started the family space (the owner). Card details only ever go to Stripe's own pages.
The publishable key (`pk_...`) is **not needed**, because the server creates the hosted Checkout page.

Use a SiblingTab-only Stripe account, never Need the Heat's. Never put keys in files, chat or git.

## What was added
- `supabase/migrations/008_billing.sql`: `family_billing` table (members can read their plan status; only the functions write).
- `supabase/functions/stripe-checkout`: opens Stripe Checkout or the Stripe customer portal. Keep "Verify JWT" ON.
- `supabase/functions/stripe-webhook`: receives Stripe's notices and updates the plan status. Turn "Verify JWT" OFF (it checks Stripe's signature instead).
- App: a "Plan" card on the Family tab (hidden until the table exists). Nothing is blocked behind payment yet.
- Tests: `node --experimental-strip-types tests/stripe.test.js`

## Turning the Plan card on or off
The Plan card and "Start free trial" button are hidden unless `billingEnabled: true` in `app/config.js` (it ships as `false`). To switch it on, set it to `true`, bump the `?v=` numbers in `index.html` and the cache name in `sw.js`, and merge. Do this only after live keys are in place (step 6).

## Setup order
1. Supabase SQL Editor: run `008_billing.sql`.
2. Secrets already set: `STRIPE_SECRET_KEY` (`sk_test_...`). Optional: `TRIAL_DAYS`, `STRIPE_PRICE_ID`, `APP_URL`.
3. Deploy both functions (`stripe-webhook` without JWT verification).
4. Stripe Dashboard (test mode) -> Developers -> Webhooks -> Add endpoint:
   URL `https://oeoztluulroglfbvwyon.supabase.co/functions/v1/stripe-webhook`, events
   `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`.
   Copy the signing secret (`whsec_...`) into the Supabase secret `STRIPE_WEBHOOK_SECRET`.
5. Test: Family tab -> Start free trial -> card `4242 4242 4242 4242`, any future date and CVC. The Plan card should show the trial.
   Then "Manage billing" to cancel. Failure card: `4000 0000 0000 0341`.
6. Going live later: new `sk_live_` key and webhook secret, and Stripe business details (registered name, bank). Taxes (GST/HST) to be decided with the accountant.
