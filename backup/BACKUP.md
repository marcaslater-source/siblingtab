# SiblingTab weekly backup (plain steps)

## What Supabase gives you today
- **Free plan: no automatic backups.** Supabase's own docs say to export regularly yourself.
- **Pro plan (US$25/month):** daily backups kept 7 days, restored from the dashboard. Point-in-time recovery is an extra ~US$100/month: skip it.
- **Either plan: receipt photos are NOT in Supabase backups.** Their docs say database backups don't include Storage files. So a backup of receipts needs its own step (below).

## Recommended: free weekly backup onto your own Mac (stays in Canada)
Every Sunday 3 AM a script saves: all accounts and expenses, the list of receipts, and (optional) the receipt photos, into one **encrypted** file in `~/SiblingTab-Backups`. It keeps the latest 8. Cost: $0. Limits: your Mac must be on/awake sometime Sunday (it catches up when it wakes); a Mac-only copy dies with the Mac, so once a month copy the newest file to a USB drive or a second drive you own.
Why not GitHub or cloud storage? Those servers are mostly in the US, which would move families' data out of Canada. Only do that if you decide to.

**If you want zero effort and a paid answer:** Pro at US$25/month covers the database daily; you'd still need the receipt step. Your call, I'd wait until real families are using it.

### Setup (~20 min, once)
1. Install tools: open Terminal, paste `brew install libpq rclone` (if you lack Homebrew, tell Claude). Then `brew link --force libpq`.
2. Turn on **FileVault** (System Settings → Privacy & Security) so the backup folder is encrypted on disk.
3. Make the folder `~/siblingtab-backup` and put `backup.sh` in it (from the repo's `siblingtab-app/backup/`).
4. Make a passphrase file: in Terminal run `openssl rand -base64 32 > ~/.siblingtab-backup.key && chmod 600 ~/.siblingtab-backup.key`. **Copy that text into your password manager**: without it, backups can't be opened.
5. Supabase dashboard → **Connect** → copy the **Session pooler** connection string and put your database password in it (Database Settings → reset password if lost).
6. Create `~/.siblingtab-backup.env` with TextEdit (plain text), then run `chmod 600 ~/.siblingtab-backup.env`:
```
DB_URL="postgresql://postgres.oeoztluulroglfbvwyon:YOURPASSWORD@<pooler-host>:5432/postgres"
PASSPHRASE_FILE="$HOME/.siblingtab-backup.key"
```
   Don't paste any of this in chat.
7. Receipt photos (optional but recommended): Supabase → Storage → **S3 Configuration** → create an access key. Add to the same env file: `S3_ENDPOINT="https://oeoztluulroglfbvwyon.storage.supabase.co/storage/v1/s3"`, `S3_KEY_ID="..."`, `S3_SECRET="..."`.
8. Test: `bash ~/siblingtab-backup/backup.sh`. You should see `OK:` and a file in `~/SiblingTab-Backups`.
9. Schedule: edit `com.siblingtab.backup.plist` (replace YOURNAME with your Mac username), copy to `~/Library/LaunchAgents/`, run `launchctl load ~/Library/LaunchAgents/com.siblingtab.backup.plist`.
10. Put a monthly calendar reminder: "Check backup file is recent + copy to USB."

## Restore (if the project is lost or broken)
1. Make a **new** Supabase project in Canada (Central). Don't delete the broken one yet.
2. SQL Editor: run `schema.sql`, then migrations 002–006, in order (they're in the repo).
3. Decrypt: `openssl enc -d -aes-256-cbc -pbkdf2 -pass file:$HOME/.siblingtab-backup.key -in siblingtab-DATE.tar.gz.enc | tar -xz`
4. Load data with Postgres: `psql "NEW_SESSION_POOLER_URL" -v ON_ERROR_STOP=1 -c "set session_replication_role = replica" -f DATE/data.sql` (use one `psql` session with `--single-transaction` and both commands if triggers complain).
5. Put receipts back: `rclone copy DATE/receipts newsb:receipts` (same S3 setup against the new project).
6. Point the app at the new project (config.js URL + key), redo Auth URL settings and SMTP, re-upload to SiteGround.

## Test it (do this once soon, and after big changes)
Make a free throwaway Supabase project (Canada), follow Restore steps 2–5 into it, then sign in there with your own account and check expenses and a receipt open. Delete the throwaway afterward. I haven't run any of this against your live project (the container can't reach Supabase), so this first test matters.

## Who can see the backups
Only whoever can log into your Mac user account, or holds your USB drive. Files are AES-256 encrypted with the passphrase in your password manager. Anyone with both the file and the passphrase could read every family's finances, so keep them apart and never email or upload them.

## Privacy policy line (not added; landing page untouched)
privacy.html already says copies may remain in providers' backups. Suggested addition: "We also keep an encrypted weekly backup of our database on secured storage in Canada, retained for up to 8 weeks, so we can restore your data if something goes wrong. Deleted accounts may remain in these backups until they expire."
