# Automatic receipt reading: how to turn it on

What it does: when someone adds an expense and picks a receipt photo, the app sends a small copy of the photo
to a Claude model (Sonnet 5.5) through a Supabase Edge Function. The amount, date, store and a suggested
category are filled in for the person to check and change. If anything goes wrong (no signal, daily limit, blurry
photo) the person just types the details as before. The photo is never stored by the function; the only thing
kept is a "scanned once" counter used for daily limits (migration 007).

Limits (change with function secrets if needed): 15 readings per person per day, 300 per day for everyone.
Each reading is one small image plus about 300 tokens of answer, so cost is a fraction of a cent to about a cent.

## What only Marc can do (2 minutes)
1. Anthropic Console (console.anthropic.com) -> create an account for SiblingTab, add a small prepaid credit
   (for example US$10) and under Settings -> Limits set a **monthly spend limit** (for example US$10).
2. Settings -> API keys -> Create key, named `siblingtab-receipts`. Copy it once.
3. Supabase (siblingtab-canada) -> Edge Functions -> Secrets -> add `ANTHROPIC_API_KEY` = the key. Never paste it in chat, files or GitHub.

## The rest (Claude can do these)
1. SQL Editor: run `supabase/migrations/007_receipt_scan_limits.sql`.
2. Edge Functions -> Deploy a new function named `read-receipt`, paste `supabase/functions/read-receipt/index.ts`.
   Leave **Verify JWT ON** (only signed-in people can use it).
3. Merge the pull request (the app deploys automatically), then try an expense with a receipt photo.

Until steps above are done the app still works: the reader just reports "couldn't read" and people type as usual.

## Tests
`node tests/logic.test.js`, `node --experimental-strip-types tests/read-receipt.test.js` (Node 22+), and the browser test in `tests/e2e-playwright.js`.

## Receipt counts on the App stats page
Run `supabase/migrations/009_receipt_stats.sql` once (after 007). The owner-only App stats page then shows a
"Receipts" section: receipts uploaded, auto-reads, how many worked or failed, a 14-day table, and a rough cost
estimate (US$0.01 per reading, edit `cost_per_reading` in the SQL). These are counts only, computed from the
database; nothing is sent to Google Analytics or any other service. Each reading is logged as who/when/how it
ended (never the image or what was read) and kept for 90 days. Re-deploy the `read-receipt` function so it
reports how each reading ended; until then the page shows older readings as "no result recorded".
