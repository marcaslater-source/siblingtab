# Putting SiblingTab live on SiteGround

No WordPress needed. The site is plain HTML files. Signups go to Formspree (free), so nothing runs on the server.

## 1. Set up the signup form (Formspree, free)

1. Make a free account at formspree.io and create a new form called "SiblingTab waitlist". Set the notification email to your inbox.
2. Formspree shows an endpoint like `https://formspree.io/f/abcdwxyz`. The last part (`abcdwxyz`) is your form ID.
3. Done: the site already points at your form `xwlopowy`.

Both the waitlist and the follow-up survey go to the same Formspree form. The `form` field on each submission says which one it was (`waitlist` or `survey`), and `source` says which signup box was used (`hero` or `checklist`).

Free plan: 50 submissions a month. Fine for validation; Formspree's paid plan or MailerLite (free up to 1,000 subscribers) are the next step if you outgrow it.

## 2. Upload to SiteGround

1. In SiteGround **Site Tools** for your site (the temporary one is fine), open **Site → File Manager**.
2. Open `public_html`. If it has a default `index.html` or WordPress files from setup, delete them (or create a fresh site with "Start new website → Skip/Blank").
3. Upload `siblingtab-landing-page.zip` into `public_html`, right-click it, choose **Extract**, then delete the zip. You should see `index.html`, `thanks.html`, `img/`, `downloads/` directly inside `public_html` (not in a subfolder).
4. Visit your temporary URL. SiteGround's temp domains look like `something.sg-host.com`.

## 3. Test it

- Sign up with your own email in both boxes. Each should land on the thank-you page with both downloads working.
- The first submission to a new Formspree form sends you a confirmation email. Click it, or later submissions won't be saved.
- Check the submission shows in your Formspree dashboard.
- Open it on your phone too.

## 4. Your domain

siblingtab.com is the site's domain (attached in SiteGround, with the free Let's Encrypt certificate and HTTPS Enforce on). The app lives at app.siblingtab.com.

- **Email → Accounts**: create `hello@siblingtab.com` (used in the footer, privacy policy and terms) or forward it to your Gmail.
- After uploading new files, flush **Speed → Caching → Dynamic Cache** or visitors keep seeing the old pages.

## 5. After launch

- Export signups any time from Formspree (CSV). Survey answers with "open to a call" ticked are your interview list.
- Share `yourdomain/#checklist` in caregiver Facebook groups, r/AgingParents, r/PersonalFinanceCanada, and with anyone you interview.
- The checklist figures are for the 2026 return. Refresh them each January.

## 6. Google Analytics and Search Console

- Analytics property "SiblingTab website" (measurement ID `G-F5ZQJB9XVB`) in your existing Google Analytics account. Google signals and ads personalization are off.
- `consent.js` (site root) shows an Allow / No thanks banner. Analytics only loads after Allow (Quebec Law 25). "Cookie settings" in the footer reopens it. Every page loads it, so keep the script line when adding pages.
- Search Console: `https://siblingtab.com/` is verified with the `google-site-verification` meta tag in index.html. Don't remove it. Sitemap: `sitemap.xml`.
- Analytics is not used in the app (app.siblingtab.com), and the privacy policy says so.
