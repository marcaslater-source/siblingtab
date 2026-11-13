#!/bin/bash
# SiblingTab weekly backup. Runs on YOUR Mac; backups stay on your Mac (Canada).
# Secrets live only in ~/.siblingtab-backup.env (never in chat or GitHub). See BACKUP.md.
set -euo pipefail
export PATH="/opt/homebrew/bin:/opt/homebrew/opt/libpq/bin:/usr/local/bin:/usr/local/opt/libpq/bin:$PATH"
source "$HOME/.siblingtab-backup.env"   # DB_URL, PASSPHRASE_FILE, optional S3_* for receipts
DEST="${BACKUP_DIR:-$HOME/SiblingTab-Backups}"
STAMP="$(date +%Y-%m-%d)"
WORK="$DEST/$STAMP"
mkdir -p "$WORK"; chmod 700 "$DEST" "$WORK"

# 1. Database data: sign-ins (auth) + all app tables (public) + receipt file list (storage.objects)
pg_dump "$DB_URL" --data-only --no-owner --no-privileges --schema=public --schema=auth -f "$WORK/data.sql"
pg_dump "$DB_URL" --data-only --no-owner --no-privileges --table=storage.objects --table=storage.buckets -f "$WORK/storage-index.sql"

# 2. Receipt photos (optional, needs rclone + S3 keys from Supabase Storage settings)
if [ -n "${S3_ENDPOINT:-}" ]; then
  RCLONE_CONFIG_SB_TYPE=s3 RCLONE_CONFIG_SB_PROVIDER=Other \
  RCLONE_CONFIG_SB_ACCESS_KEY_ID="$S3_KEY_ID" RCLONE_CONFIG_SB_SECRET_ACCESS_KEY="$S3_SECRET" \
  RCLONE_CONFIG_SB_ENDPOINT="$S3_ENDPOINT" RCLONE_CONFIG_SB_REGION="${S3_REGION:-ca-central-1}" \
  rclone copy sb:receipts "$WORK/receipts" --quiet
fi

# 3. Pack + encrypt, then remove the loose files
tar -C "$DEST" -czf - "$STAMP" | openssl enc -aes-256-cbc -pbkdf2 -salt -pass "file:$PASSPHRASE_FILE" -out "$DEST/siblingtab-$STAMP.tar.gz.enc"
rm -rf "$WORK"; chmod 600 "$DEST"/*.enc

# 4. Sanity check + keep the newest 8
[ "$(stat -f%z "$DEST/siblingtab-$STAMP.tar.gz.enc")" -gt 1000 ] || { echo "Backup looks empty!"; exit 1; }
ls -1t "$DEST"/siblingtab-*.enc | tail -n +9 | xargs -I{} rm -f {}
echo "OK: $DEST/siblingtab-$STAMP.tar.gz.enc"
