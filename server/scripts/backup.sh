#!/bin/bash
# TaskDesk backup: a consistent copy of the live database (SQLite online backup through the running container, so the
# server keeps running) plus data/uploads/, into ~/TaskDesk-backups/YYYY-MM-DD/. A second run on the same day replaces
# that day's copy. Keeps the newest 14 days. Verifies each copy (read-only: integrity, foreign keys, row counts, every
# stored file present). Everything is logged to ~/TaskDesk-backups/backup.log. Restore: see restore.md next to this file.
# Run by cron at 13:00 and 18:00 (crontab -l). Exit code 0 = backup made and verified.
set -u
export PATH=/usr/local/bin:/usr/bin:/bin
CONTAINER=${TASKDESK_CONTAINER:-taskdesk}
DEST_ROOT="$HOME/TaskDesk-backups"
KEEP=14
DAY=$(date +%F)
LOG="$DEST_ROOT/backup.log"
mkdir -p "$DEST_ROOT"
exec >>"$LOG" 2>&1   # every message (and any error from the tools) goes to the log
log() { echo "$(date '+%F %T') $*"; }
TMP=""; IN=/tmp/taskdesk-backup-$$.db
fail() { log "FAILED: $*"; [ -n "$TMP" ] && rm -rf "$TMP"; docker exec "$CONTAINER" rm -f "$IN" >/dev/null 2>&1; exit 1; }

exec 9>"$DEST_ROOT/.lock"
flock -n 9 || { log "Another backup is still running; skipped."; exit 0; }

log "Backup started"
docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -q true || fail "the $CONTAINER container is not running (start it with: cd ~/Downloads/TaskDesk/server && docker compose up -d)"
TMP=$(mktemp -d "$DEST_ROOT/.tmp-$DAY-XXXXXX")

# 1. Database: SQLite's online backup API (better-sqlite3 db.backup) gives a consistent copy while the server runs.
docker exec "$CONTAINER" node -e "
  const D = require('/app/node_modules/better-sqlite3');
  const db = new D('/app/data/taskdesk.db', { readonly: true, fileMustExist: true });
  db.backup(process.argv[1]).then(() => db.close()).catch(e => { console.error(e.message); process.exit(1); });" "$IN" \
  || fail "the database backup inside the container failed"
docker cp -q "$CONTAINER:$IN" "$TMP/taskdesk.db" || fail "could not copy the backup out of the container"
docker exec "$CONTAINER" rm -f "$IN"

# 2. Uploaded files, copied after the database: every file the copy refers to was already on disk.
docker cp -q "$CONTAINER:/app/data/uploads" "$TMP/uploads" || fail "could not copy data/uploads"

# 3. Verify: open the copy read-only, check integrity and foreign keys, count rows, and check every stored file is there.
RESULT=$(python3 -I - "$TMP/taskdesk.db" "$TMP/uploads" <<'PY'
import os, sqlite3, sys
db, uploads = sys.argv[1], sys.argv[2]
c = sqlite3.connect(f'file:{db}?immutable=1', uri=True)
integrity = c.execute('PRAGMA integrity_check').fetchone()[0]
fk = c.execute('PRAGMA foreign_key_check').fetchall()
tables = [r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
counts = ' '.join(f'{t}={c.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]}' for t in tables)
stored = [r[0] for r in c.execute('SELECT stored_name FROM files')]
missing = [s for s in stored if not os.path.isfile(os.path.join(uploads, s))]
ok = integrity == 'ok' and not fk and not missing
print(('OK' if ok else 'BAD') + f' | integrity {integrity} | foreign keys {"ok" if not fk else str(len(fk)) + " problems"}'
      + f' | files {len(stored) - len(missing)}/{len(stored)} present' + (f' (missing: {", ".join(missing[:5])})' if missing else '')
      + f' | {counts}')
PY
) || fail "could not open the backup copy to verify it"
log "Verify: $RESULT"
[ "${RESULT%% *}" = OK ] || fail "the backup copy did not pass the check (kept in $TMP for a look)"

# 4. Replace today's backup, then keep only the newest $KEEP days.
rm -rf "${DEST_ROOT:?}/$DAY" && mv "$TMP" "$DEST_ROOT/$DAY" || fail "could not move the backup into $DEST_ROOT/$DAY"
TMP=""
log "Saved $DEST_ROOT/$DAY ($(du -sh "$DEST_ROOT/$DAY" | cut -f1); database $(du -h "$DEST_ROOT/$DAY/taskdesk.db" | cut -f1), $(ls "$DEST_ROOT/$DAY/uploads" | wc -l) uploaded files)"
ls -1d "$DEST_ROOT"/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] 2>/dev/null | sort | head -n -"$KEEP" | while read -r old; do
  rm -rf "$old" && log "Removed old backup $(basename "$old")"
done
log "Backup finished ($(ls -1d "$DEST_ROOT"/[0-9][0-9][0-9][0-9]-* | wc -l) daily backups kept)"
