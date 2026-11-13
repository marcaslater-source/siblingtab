# Automatic publishing to SiteGround (your part: about 10 minutes)

Result: when a change is approved on GitHub, siblingtab.com and app.siblingtab.com update by themselves. No zips, no File Manager.

## What I found
- SiteGround allows SSH on all plans, so this works on yours.
- The cache flush can be automated through SSH, but SiteGround doesn't document the exact command. I've included a best-guess line. If it doesn't work, the first run will say so and you click Flush once (as today).

## Your steps
1. SiteGround → Site Tools (for siblingtab.com) → Devs → SSH Keys Manager → Add new → Generate. Name it "github-deploy". Leave the passphrase empty (it's for a robot).
2. Next to the key: Actions → Private Key → copy. Also open the menu → SSH Credentials and note the host name, username and port (usually 18765).
3. In Site Tools → Site → File Manager, note the folder each site lives in (usually `www/siblingtab.com/public_html` and `www/app.siblingtab.com/public_html`).
4. On GitHub: repo siblingtab → Settings → Secrets and variables → Actions → New repository secret. Add these 6:
   SG_SSH_KEY (the private key), SG_HOST, SG_USER, SG_PORT, SG_LANDING_DIR, SG_APP_DIR.
5. Tell me "done" in chat. I'll then do a test run and show you the result before anything goes live.

## Safety
- The private key lives only in GitHub secrets, never in the repo or in chat. Don't paste it to me.
- Deploys never delete files on SiteGround (no --delete), and your app's config.js must not be overwritten with the wrong IDs, so I'll check that before the first real run.
