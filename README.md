# SiblingTab web app

A phone-friendly web app (installable to the home screen) where siblings share the costs of
caring for a parent: log expenses with receipt photos, see who owes whom, record paybacks,
and export a spreadsheet for tax time.

**Marc: start with [SETUP.md](SETUP.md).** The rest of this page is technical notes.

## How it fits together

- `app/` — the whole website. Plain HTML, CSS and JavaScript: no build step. Upload the
  contents of this folder to the web host and it runs.
  - `config.js` — the Supabase project URL and public key (safe to publish; never put the
    secret/service-role key here).
  - `logic.js` — money maths (splits, balances, who-owes-whom, CSV). No network.
  - `app.js` — screens and calls to Supabase.
  - `vendor/supabase-2.118.0.js` — the Supabase library, saved locally so no outside CDN is needed.
  - `sw.js` — offline shell for the installable app. **Bump `CACHE` (and the `?v=` numbers in
    `index.html` and `sw.js`) whenever files change.**
  - `.htaccess` — HTTPS redirect, security headers (CSP), no-cache, noindex.
- `supabase/schema.sql` — the database: tables, Row Level Security rules, the app's server
  functions (`create_family`, `join_family`, `invite_info`, `save_expense`) and the private
  `receipts` storage bucket. Run once in the Supabase SQL Editor.
- `tests/` — `logic.test.js` (run `node tests/logic.test.js`) and `mock-supabase.js`, an
  in-browser fake of Supabase used to click through the app in Playwright.

## Privacy model

- Data is stored in Supabase's Canada (Central) region.
- Every table has Row Level Security: you can only read a family's data if you are a member.
  Only the person who entered an expense can edit or delete it. Column-level grants stop
  people changing things like their role. Anonymous visitors have no table access.
- Receipts are in a private bucket under `<family id>/…`, readable only by family members,
  shown through short-lived signed links.
- Money is stored as integer cents (CAD). Even splits give leftover cents to the first people.

## Not in this version

CRA tax-credit reports, caregiving task/workload tracking, in-app payments, account
self-deletion (handle deletion requests in the Supabase dashboard for now), removing members.
