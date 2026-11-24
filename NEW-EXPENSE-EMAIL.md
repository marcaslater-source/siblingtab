# New expense emails: how to turn them on

What it does: each person can switch on "Email me when someone in my family adds an expense"
(Account page, off by default). When someone adds an expense, the other active family members who
switched it on get a short email: who added it, the amount, date and category. Nothing about balances.
The person who added it never gets one. Every email has an unsubscribe link.

How it works: after saving a new expense the app calls the `expense-notify` function. The database
checks that the caller really just created that expense, claims it (so it is announced only once),
and returns the opted-in recipients. Edits never send anything. If the email step fails, saving the
expense is unaffected.

## Steps
1. **Database.** Supabase -> SQL Editor -> New query. Paste `supabase/migrations/010_new_expense_emails.sql`, Run.
2. **Function.** Deploy `supabase/functions/expense-notify/index.ts` as `expense-notify`. Leave **Verify JWT** ON.
   It uses the same SMTP_ secrets as `monthly-summary` (already set), so nothing new to add.
3. **App.** Merging the pull request publishes the app (the switch appears on the Account page).
4. **Test.** Two accounts in one family: switch it on for one, add an expense as the other.
