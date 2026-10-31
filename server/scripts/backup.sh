#!/bin/bash
# TaskDesk backup: a consistent copy of the live database (SQLite online backup through the running container, so the
# server keeps running) plus data/uploads/, into ~/TaskDesk-backups/YYYY-MM-DD/. A second run on the same day replaces
# that day's copy. Keeps the newest 14 days. Verifies each copy (read-only: integrity, foreign keys, row counts, every
# stored file present). Everything is logged to ~/TaskDesk-backups/backup.log. Restore: see restore.md next to this file.
# Run by cron at 13:00 and 18:00 (crontab -l). Exit code 0 = backup made and verified.
# The database and the files stay encrypted with master.key (Security A2), so restoring needs that key (scripts/KEYS.md).
# The keys (server/secrets/) are never part of a backup.
# Each day is then packed and encrypted with server/secrets/backup.key (openssl AES-256-CBC, PBKDF2; the key is read
# from the file, never put on a command line) into YYYY-MM-DD/taskdesk-backup.tar.enc, and that file is checked by
# decrypting it to a temporary folder and comparing it with the verified copy. Restore steps: restore.md.
set -u -o pipefail
export PATH=/usr/local/bin:/usr/bin:/bin
CONTAINER=${TASKDESK_CONTAINER:-taskdesk}
SERVER_DIR=$(cd "$(dirname "$0")/.." && pwd)
BACKUP_KEY=${BACKUP_KEY:-$SERVER_DIR/secrets/backup.key}
ENC=(-aes-256-cbc -pbkdf2 -iter 200000 -md sha256)   # the same options decrypt it (restore.md)
DEST_ROOT="$HOME/TaskDesk-backups"
KEEP=14
DAY=$(date +%F)
LOG="$DEST_ROOT/backup.log"
mkdir -p "$DEST_ROOT"
exec >>"$LOG" 2>&1   # every message (and any error from the tools) goes to the log
log() { echo "$(date '+%F %T') $*"; }
TMP=""; OUT=""; CHK=""; IN=/tmp/taskdesk-backup-$$.db
fail() { log "FAILED: $*"; for d in "$TMP" "$OUT" "$CHK"; do [ -n "$d" ] && rm -rf "$d"; done; docker exec "$CONTAINER" rm -f "$IN" >/dev/null 2>&1; exit 1; }

exec 9>"$DEST_ROOT/.lock"
flock -n 9 || { log "Another backup is still running; skipped."; exit 0; }

log "Backup started"
[ -r "$BACKUP_KEY" ] || fail "$BACKUP_KEY is missing. Put back your USB copy (scripts/KEYS.md); a new key can't open older backups."
docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -q true || fail "the $CONTAINER container is not running (start it with: cd ~/Downloads/TaskDesk/server && docker compose up -d)"
TMP=$(mktemp -d "$DEST_ROOT/.tmp-$DAY-XXXXXX")

# 1. Database: an encrypted copy made inside the container (dbfile.js exportCopy: a new database keyed like the live
#    one, every table read in one read transaction, so the copy is consistent while the server keeps running; SQLite's
#    own backup API can't write an encrypted copy). The copy is then checked there, read-only: integrity, foreign
#    keys, row counts, the stored file names, and its SHA-256 (to make sure the file copied out is the one checked).
CHECKED=$(docker exec "$CONTAINER" node -e "
  const dbfile = require('/app/dbfile'), fs = require('fs'), crypto = require('crypto'), out = process.argv[1];
  const src = dbfile.openDb('/app/data/taskdesk.db', { readonly: true, fileMustExist: true });
  dbfile.exportCopy(src, out); src.close();
  const c = dbfile.openDb(out, { readonly: true, fileMustExist: true }), h = dbfile.health(c);
  const tables = c.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name\").all().map(r => r.name);
  const counts = tables.map(t => t + '=' + c.prepare('SELECT COUNT(*) AS n FROM \"' + t + '\"').get().n).join(' ');
  const stored = c.prepare('SELECT stored_name FROM files').all().map(r => r.stored_name); c.close();
  console.log(JSON.stringify({ integrity: h.integrity, fk: h.foreign_key_problems, counts, stored,
    plain: dbfile.isPlainSqlite(out), sha256: crypto.createHash('sha256').update(fs.readFileSync(out)).digest('hex') }));" "$IN") \
  || fail "the database copy inside the container failed"
docker cp -q "$CONTAINER:$IN" "$TMP/taskdesk.db" || fail "could not copy the backup out of the container"
docker exec "$CONTAINER" rm -f "$IN"

# 2. Uploaded files (encrypted on disk), copied after the database: every file the copy refers to was already there.
docker cp -q "$CONTAINER:/app/data/uploads" "$TMP/uploads" || fail "could not copy data/uploads"

# 3. Verify: the checks above passed, the copied file is the one checked, it's encrypted, and every stored file is
#    there and encrypted too (starts with TDF1, see filecrypt.js).
RESULT=$(python3 -I - "$TMP/taskdesk.db" "$TMP/uploads" "$CHECKED" <<'PY'
import hashlib, json, os, sys
db, uploads, c = sys.argv[1], sys.argv[2], json.loads(sys.argv[3])
same = hashlib.sha256(open(db, 'rb').read()).hexdigest() == c['sha256']
missing = [s for s in c['stored'] if not os.path.isfile(os.path.join(uploads, s))]
plain_files = [n for n in os.listdir(uploads) if open(os.path.join(uploads, n), 'rb').read(4) != b'TDF1']
ok = c['integrity'] == 'ok' and not c['fk'] and same and not c['plain'] and not missing and not plain_files
print(('OK' if ok else 'BAD') + f' | integrity {c["integrity"]} | foreign keys {"ok" if not c["fk"] else str(c["fk"]) + " problems"}'
      + f' | database {"encrypted" if not c["plain"] else "NOT ENCRYPTED"}, copy {"identical" if same else "DIFFERS"}'
      + f' | files {len(c["stored"]) - len(missing)}/{len(c["stored"])} present' + (f' (missing: {", ".join(missing[:5])})' if missing else '')
      + (f' | {len(plain_files)} files NOT ENCRYPTED' if plain_files else ', all encrypted') + f' | {c["counts"]}')
PY
) || fail "could not verify the backup copy"
log "Verify: $RESULT"
[ "${RESULT%% *}" = OK ] || fail "the backup copy did not pass the check"

# 4. Pack and encrypt with backup.key, then check the encrypted file by decrypting it to a temporary folder: it must
#    give back exactly the verified copy.
OUT=$(mktemp -d "$DEST_ROOT/.tmp-$DAY-enc-XXXXXX"); CHK=$(mktemp -d "$DEST_ROOT/.tmp-$DAY-check-XXXXXX")
tar -C "$TMP" -cf - taskdesk.db uploads | openssl enc "${ENC[@]}" -salt -pass "file:$BACKUP_KEY" -out "$OUT/taskdesk-backup.tar.enc" \
  || fail "could not encrypt the backup"
[ "$(head -c 8 "$OUT/taskdesk-backup.tar.enc")" = "Salted__" ] || fail "the encrypted file doesn't look encrypted"
openssl enc -d "${ENC[@]}" -pass "file:$BACKUP_KEY" -in "$OUT/taskdesk-backup.tar.enc" | tar -x -C "$CHK" \
  || fail "the encrypted backup could not be decrypted again"
diff -r "$TMP" "$CHK" >/dev/null || fail "the decrypted backup differs from the verified copy"
log "Encrypted with backup.key; decrypting it again gives the verified copy back ($(ls "$CHK/uploads" | wc -l) files)"
rm -rf "$TMP" "$CHK"; TMP=""; CHK=""
(cd "$OUT" && sha256sum taskdesk-backup.tar.enc > taskdesk-backup.tar.enc.sha256) || fail "could not write the checksum"

# 5. Replace today's backup, then keep only the newest $KEEP days.
rm -rf "${DEST_ROOT:?}/$DAY" && mv "$OUT" "$DEST_ROOT/$DAY" || fail "could not move the backup into $DEST_ROOT/$DAY"
OUT=""
chmod 700 "$DEST_ROOT/$DAY"
log "Saved $DEST_ROOT/$DAY/taskdesk-backup.tar.enc ($(du -h "$DEST_ROOT/$DAY/taskdesk-backup.tar.enc" | cut -f1))"
ls -1d "$DEST_ROOT"/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] 2>/dev/null | sort | head -n -"$KEEP" | while read -r old; do
  rm -rf "$old" && log "Removed old backup $(basename "$old")"
done
log "Backup finished ($(ls -1d "$DEST_ROOT"/[0-9][0-9][0-9][0-9]-* | wc -l) daily backups kept)"
