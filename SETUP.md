# Putting SiblingTab online

About 45 minutes, all free. There are three parts:

1. **Supabase** stores accounts, expenses and receipt photos (in Canada).
2. **Email sending** so siblings get their "confirm your email" messages.
3. **SiteGround** shows the app at **app.siblingtab.com**.

Do Part 1, then send Claude the two values from step 1.4. Claude will put them into the app
and give you a ready-to-upload zip file for Part 3.

---

## Part 1: Supabase (the database)

**1.1 Make an account.** Go to [supabase.com](https://supabase.com), click **Start your project**,
and sign up (the "Continue with GitHub" button works well now that you have GitHub). The free
plan is fine. Don't enter a credit card.

**1.2 Create the project.** Click **New project** and fill in:
- **Name:** `siblingtab`
- **Database password:** click **Generate a password**, then save it in your password manager.
  You won't need it day to day, but don't lose it.
- **Region:** **Canada (Central)**. This keeps families' data in Canada. It can't be changed later.
- Click **Create new project** and wait a minute or two.

**1.3 Set up the database.** In the left menu, open **SQL Editor**, then click **New query**.
Open the file `supabase/schema.sql` (in the project files), copy **all** of it, paste it into the
editor and click **Run**. You should see "Success. No rows returned."
If Supabase asks you to confirm because the query is "destructive" or has many statements, click to run it anyway.

**1.4 Copy two values for Claude.** Open **Project Settings** (the gear icon), then **API Keys**
(on some screens it's called **Data API** or **API**). Copy:
- the **Project URL**, which looks like `https://abcdefgh.supabase.co`
- the **publishable** key (starts with `sb_publishable_`), or, if you only see older keys, the **anon public** key.

Send both to Claude. They're meant to be public, so it's fine to paste them in the chat.
**Never** send the key labelled **secret** or **service_role**: that one unlocks everything.

**1.5 Tell Supabase where the app lives.** Go to **Authentication** → **URL Configuration**:
- **Site URL:** `https://app.siblingtab.com`
- Under **Redirect URLs**, click **Add URL** and add `https://app.siblingtab.com/**`
- Click **Save**.

**1.6 Check the sign-up settings.** Go to **Authentication** → **Sign In / Providers** → **Email**.
Make sure **Confirm email** is turned **on**. Set the minimum password length to **8** if there's
an option for it. Save.

> **Good to know:** on the free plan, Supabase pauses a project after a week with no one using it.
> Nothing is lost: open your Supabase dashboard and click **Restore project**. Once real families
> rely on SiblingTab, the paid plan (about US$25/month) keeps it running all the time. Claude will
> remind you before anything costs money.

---

## Part 2: Email sending (so siblings can sign up)

Supabase's built-in email only sends to *you* (the project owner), so your siblings would never
get their confirmation emails. The fix is free: send through an email address on your own domain,
which your SiteGround plan already includes.

**2.1 Make a mailbox in SiteGround.** In **Site Tools** for siblingtab.com, go to
**Email** → **Accounts**. Create `noreply@siblingtab.com` with a strong generated password
(save it in your password manager).

**2.2 Find the mail server name.** Next to the new account, open the **⋮** menu → **Mail Configuration**,
then look under **Manual Settings** for the **outgoing (SMTP) server** name and port (usually 465).

**2.3 Connect it in Supabase.** Go to **Authentication** → **Emails** → **SMTP Settings**, turn on
**Enable custom SMTP**, and fill in:
- **Sender email:** `noreply@siblingtab.com`
- **Sender name:** `SiblingTab`
- **Host:** the outgoing server name from step 2.2
- **Port:** `465`
- **Username:** `noreply@siblingtab.com`
- **Password:** the mailbox password from step 2.1

Click **Save**.

---

## Part 3: SiteGround (putting the app at app.siblingtab.com)

**3.1 Make the subdomain.** In **Site Tools** for siblingtab.com, go to **Domain** → **Subdomains**.
Type `app` and click **Create**. SiteGround makes a folder for it (usually
`app.siblingtab.com/public_html`).

**3.2 Turn on the padlock (HTTPS).** Go to **Security** → **SSL Manager**, choose
`app.siblingtab.com`, pick **Let's Encrypt**, and click **Get**. Wait until it says it's active.
Then go to **Security** → **HTTPS Enforce** and switch it on for app.siblingtab.com.

**3.3 Upload the app.** Go to **Site** → **File Manager** and open the subdomain's `public_html`
folder. Click **File Upload** and upload `siblingtab-app-upload.zip` (Claude will send you this file
once your Supabase values from step 1.4 are in). Right-click the zip → **Extract**, extract it into
that same `public_html` folder, then delete the zip.

The folder should now contain `index.html`, `app.js`, `config.js`, the `icons` and `vendor`
folders, and so on, directly inside `public_html` (not inside another folder).
There's also a hidden file called `.htaccess`; that's expected.

**3.4 Clear the cache.** Go to **Speed** → **Caching** → **Dynamic Cache** and click **Flush Cache**
for app.siblingtab.com. (Do this every time you upload a new version.)

**3.5 Try it.** On your phone, open **https://app.siblingtab.com**:
1. Create an account and confirm it from the email you receive.
2. Set up your family space.
3. On the **Family** tab, tap **Get an invite link** and send it to a sibling (or to a second
   email address of your own to test).
4. Add an expense with a photo of a receipt.

To put it on your home screen: on iPhone, tap **Share** → **Add to Home Screen**; on Android,
tap the **⋮** menu → **Add to Home screen** (or **Install app**).

---

## If something goes wrong

- **The page says "Almost there"**: the Supabase values in `config.js` are missing. Ask Claude.
- **No confirmation email arrives**: check spam, then re-check Part 2. In Supabase,
  **Authentication** → **Users** shows whether the person signed up.
- **You still see an old version after an update**: flush the Dynamic Cache (step 3.4), then reload.
- **Someone asks for their data to be deleted**: they can do it themselves on the **Account** page
  (**Delete my account**). Their siblings keep the shared expense history, shown as "Former member".

---

## Database updates

When an app update needs a database change, it comes as a file in `supabase/migrations/`.
Run each one once, in order, the same way as step 1.3 (SQL Editor → New query → paste → Run,
and confirm if Supabase warns about "destructive operations").

- `002_account_settings.sql`: profile photos and "delete my account" (November 2026).
