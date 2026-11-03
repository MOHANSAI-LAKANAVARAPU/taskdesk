#!/bin/bash
# Restore a TaskDesk backup into the cloud data folders (AWS prep). Works with a package made by `backup.sh --cloud`
# (taskdesk-backup-<UTC>.tar.enc + .sha256 + manifest.json) and with a laptop backup (YYYY-MM-DD/taskdesk-backup.tar.enc),
# or an old plain day folder (taskdesk.db + uploads/). Run it with the app STOPPED, as root on the host (or as the owner uid).
#
#   restore-cloud.sh <backup file | folder> [--data /srv/taskdesk/data] [--keys-dir /run/taskdesk/keys]
#                    [--owner 1000:1000] [--updates-from <dir> --updates /srv/taskdesk/updates]
#                    [--keys-from-secret <secret ARN or name> [--region <aws region>]]
#                    [--image taskdesk-taskdesk] [--container taskdesk] [--yes]
#
# What it does, in order (the current data is moved aside, never deleted):
#   1. checks the SHA-256 file, decrypts with backup.key (BACKUP_KEY, else <keys-dir>/backup.key) into a private folder next
#      to the data folder (same disk);  2. refuses when the app container is running;  3. moves the existing data to
#      <data>.before-restore-<time>;  4. puts taskdesk.db and uploads/ in place, owner 1000:1000, folders 700, files 600;
#   5. checks in a throw-away hardened container of the app image (no network, read-only, no capabilities): the database
#      opens with master.key (so the keys fit), integrity_check, foreign keys, every table's row count equals the manifest
#      (printed when there is no manifest), every uploaded file the database names is present and encrypted, the copied file
#      is byte-identical to the backup's;  6. optional: copies desktop installers (--updates-from) into the updates folder.
# Keys: /run/taskdesk/keys is only filled when the launcher STARTS the app, but the workbook restores BEFORE the first start. With
# --keys-from-secret the script reads master_key_b64 / backup_key_b64 from that Secrets Manager secret (aws CLI, the host's
# role) into a private folder on /dev/shm (root:<gid>, 750 / 640, like the launcher) and shreds it on exit; nothing is printed.
# Exit 0 only when every check passed. If a check fails, the restored data is moved to <data>.failed-restore-<time> and the
# previous data is put back, so a bad restore never stays in place. Keys and passwords are never printed.
set -u -o pipefail
export PATH=/usr/local/bin:/usr/bin:/bin
DATA=/srv/taskdesk/data; KEYS_DIR=${KEYS_DIR:-/run/taskdesk/keys}; OWNER=1000:1000; UPDATES=""; UPDATES_FROM=""
IMAGE=taskdesk-taskdesk; CONTAINER=taskdesk; YES=0; SRC=""; SECRET=""; REGION=""; KEYTMP=""
KEYS_DIR_GIVEN=0""
ENC=(-aes-256-cbc -pbkdf2 -iter 200000 -md sha256)
log() { echo "$(date -u '+%F %T') $*"; }
die() { log "FAILED: $*"; cleanup; exit 1; }
TMP=""; ASIDE=""; PLACED=0
cleanup() {
  [ -n "$TMP" ] && rm -rf "$TMP"; TMP=""
  if [ -n "$KEYTMP" ]; then find "$KEYTMP" -type f -exec shred -u {} + 2>/dev/null; rm -rf "$KEYTMP"; KEYTMP=""; fi
}
trap cleanup EXIT
usage() { sed -n '2,6p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }

while [ $# -gt 0 ]; do
  case "$1" in
    --data) DATA=${2:?}; shift 2 ;;
    --keys-dir) KEYS_DIR=${2:?}; KEYS_DIR_GIVEN=1; shift 2 ;;
    --keys-from-secret) SECRET=${2:?}; shift 2 ;;
    --region) REGION=${2:?}; shift 2 ;;
    --owner) OWNER=${2:?}; shift 2 ;;
    --updates) UPDATES=${2:?}; shift 2 ;;
    --updates-from) UPDATES_FROM=${2:?}; shift 2 ;;
    --image) IMAGE=${2:?}; shift 2 ;;
    --container) CONTAINER=${2:?}; shift 2 ;;
    --yes) YES=1; shift ;;
    -h|--help) usage ;;
    -*) echo "restore-cloud.sh: unknown option $1" >&2; usage ;;
    *) [ -z "$SRC" ] && SRC=$1 || { echo "restore-cloud.sh: one backup only" >&2; usage; }; shift ;;
  esac
done
[ -n "$SRC" ] || usage
[[ $OWNER =~ ^[0-9]+:[0-9]+$ ]] || die "--owner must be numeric uid:gid, e.g. 1000:1000"
if [ -n "$SECRET" ]; then
  [ "$KEYS_DIR_GIVEN" = 0 ] || die "use either --keys-dir or --keys-from-secret"
  AWS=${AWS_CLI:-aws}   # AWS_CLI: another path, for tests
  command -v "$AWS" >/dev/null 2>&1 || die "--keys-from-secret needs the aws CLI"
  KEYTMP=$(mktemp -d /dev/shm/taskdesk-restore-keys.XXXXXX) || die "could not make a key folder on /dev/shm"
  chmod 750 "$KEYTMP"; chown "0:${OWNER#*:}" "$KEYTMP" 2>/dev/null || chown "$(id -u):${OWNER#*:}" "$KEYTMP" 2>/dev/null || true
  "$AWS" secretsmanager get-secret-value --secret-id "$SECRET" ${REGION:+--region "$REGION"} --query SecretString --output text 2>/dev/null \
    | python3 -I -c '
import base64, json, os, sys
d = json.loads(sys.stdin.read()); out = sys.argv[1]
for name, field in (("master.key", "master_key_b64"), ("backup.key", "backup_key_b64")):
    b = base64.b64decode(d[field], validate=True)
    if not b: sys.exit(1)
    fd = os.open(os.path.join(out, name), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o640); os.write(fd, b); os.close(fd)
' "$KEYTMP" || die "could not read the keys from the secret (aws role, secret name/region, or the secret's JSON)"
  chown "0:${OWNER#*:}" "$KEYTMP"/*.key 2>/dev/null || chown "$(id -u):${OWNER#*:}" "$KEYTMP"/*.key 2>/dev/null || true
  chmod 640 "$KEYTMP"/*.key
  KEYS_DIR=$KEYTMP; log "Keys read from the secret (not printed, removed when the script ends)"
fi
BACKUP_KEY=${BACKUP_KEY:-$KEYS_DIR/backup.key}
DATA=${DATA%/}; PARENT=$(dirname "$DATA")
[ -d "$PARENT" ] && [ -w "$PARENT" ] || die "$PARENT is not a writable directory"
[ -r "$KEYS_DIR/master.key" ] || die "$KEYS_DIR/master.key is missing: the restored database could not be checked (the keys must be in place first)"

# ---- 1. find the backup
ENCFILE=""; PLAIN=""
if [ -f "$SRC" ]; then ENCFILE=$SRC
elif [ -d "$SRC" ]; then
  if [ -f "$SRC/taskdesk.db" ] && [ -d "$SRC/uploads" ]; then PLAIN=$SRC
  else ENCFILE=$(ls -1t "$SRC"/taskdesk-backup*.tar.enc 2>/dev/null | head -n 1); [ -n "$ENCFILE" ] || die "no taskdesk-backup*.tar.enc in $SRC"; fi
else die "$SRC does not exist"; fi
MANIFEST=""
if [ -n "$ENCFILE" ]; then
  [ -r "$BACKUP_KEY" ] || die "$BACKUP_KEY is missing: it is needed to decrypt the backup"
  if [ -f "$ENCFILE.sha256" ]; then
    (cd "$(dirname "$ENCFILE")" && sha256sum -c "$(basename "$ENCFILE").sha256" >/dev/null 2>&1) || die "the checksum of $(basename "$ENCFILE") does not match: the file is damaged or incomplete"
    log "Checksum OK ($(basename "$ENCFILE"))"
  else log "Warning: no .sha256 file next to the backup; relying on decryption"; fi
  m="${ENCFILE%.tar.enc}.manifest.json"; [ -f "$m" ] && MANIFEST=$m
fi

# ---- 2. the app must be stopped
if command -v docker >/dev/null 2>&1 && [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" = true ]; then
  die "the $CONTAINER container is running. Stop it first (systemctl stop taskdesk)."
fi
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
if [ -e "$DATA" ] && [ -n "$(ls -A "$DATA" 2>/dev/null)" ]; then
  if [ "$YES" != 1 ]; then
    [ -t 0 ] || die "$DATA already holds data. Run again with --yes to move it aside to $DATA.before-restore-$STAMP and restore."
    read -r -p "$DATA holds data; move it to $DATA.before-restore-$STAMP and restore? [y/N] " a; [ "$a" = y ] || die "cancelled"
  fi
fi

# ---- 3. unpack beside the data folder
TMP=$(mktemp -d "$PARENT/.restore-tmp-XXXXXX") || die "could not make a work folder in $PARENT"; chmod 700 "$TMP"
trap 'die "interrupted"' INT TERM
if [ -n "$PLAIN" ]; then
  cp -a "$PLAIN/taskdesk.db" "$TMP/taskdesk.db" && cp -a "$PLAIN/uploads" "$TMP/uploads" || die "could not copy the plain backup"
else
  openssl enc -d "${ENC[@]}" -pass "file:$BACKUP_KEY" -in "$ENCFILE" 2>/dev/null | tar -x --no-same-owner --no-same-permissions -C "$TMP" 2>/dev/null \
    || die "could not decrypt $(basename "$ENCFILE") (wrong backup.key, or the file is damaged)"
fi
[ -f "$TMP/taskdesk.db" ] || die "the backup has no taskdesk.db"
[ -d "$TMP/uploads" ] || mkdir -m 700 "$TMP/uploads"
for x in "$TMP"/*; do case "$(basename "$x")" in taskdesk.db|uploads) ;; *) die "unexpected item in the backup: $(basename "$x")";; esac; done
DB_SHA=$(sha256sum "$TMP/taskdesk.db" | cut -d' ' -f1)
log "Backup unpacked ($(ls "$TMP/uploads" | wc -l) uploaded files)"

# ---- 4. put it in place
if [ -e "$DATA" ]; then
  if [ -n "$(ls -A "$DATA" 2>/dev/null)" ]; then ASIDE="$DATA.before-restore-$STAMP"; mv "$DATA" "$ASIDE" || die "could not move $DATA aside"; log "Previous data moved to $ASIDE"
  else rmdir "$DATA" 2>/dev/null || true; fi
fi
mkdir -m 700 "$DATA" || { [ -n "$ASIDE" ] && mv "$ASIDE" "$DATA"; die "could not create $DATA"; }
PLACED=1
mv "$TMP/taskdesk.db" "$DATA/taskdesk.db" && mv "$TMP/uploads" "$DATA/uploads" || fail_place=1
rm -rf "$TMP"; TMP=""
rollback() { # a bad restore never stays in place
  mv "$DATA" "$DATA.failed-restore-$STAMP" 2>/dev/null
  if [ -n "$ASIDE" ]; then mv "$ASIDE" "$DATA" && log "Previous data put back in $DATA (the failed restore is in $DATA.failed-restore-$STAMP)"; fi
}
[ -z "${fail_place:-}" ] || { rollback; die "could not move the files into $DATA"; }
if ! chown -R "$OWNER" "$DATA" 2>/dev/null; then
  [ "$(stat -c %u:%g "$DATA")" = "$OWNER" ] || { rollback; die "could not set the owner of $DATA to $OWNER (run as root)"; }
fi
chmod 700 "$DATA" "$DATA/uploads"; chmod 600 "$DATA/taskdesk.db"; find "$DATA/uploads" -type f -exec chmod 600 {} +
log "Data in place: $DATA (owner $OWNER, folders 700, files 600)"

# ---- 5. checks in a hardened throw-away container
command -v docker >/dev/null 2>&1 || { rollback; die "docker is needed for the database checks"; }
read -r -d '' CHECK_JS <<'JS'
const dbfile = require('/app/dbfile'), fs = require('fs');
const db = dbfile.openDb('/d/taskdesk.db', { readonly: true, fileMustExist: true });
const h = dbfile.health(db);
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r => r.name);
const counts = {}; for (const t of tables) counts[t] = db.prepare('SELECT COUNT(*) AS n FROM "' + t + '"').get().n;
const stored = db.prepare('SELECT stored_name FROM files').all().map(r => r.stored_name);
const missing = [], plain = [];
for (const s of stored) { try { const fd = fs.openSync('/d/uploads/' + s, 'r'); const b = Buffer.alloc(4); fs.readSync(fd, b, 0, 4, 0); fs.closeSync(fd); if (b.toString() !== 'TDF1') plain.push(s); } catch (e) { missing.push(s); } }
let onDisk = 0; try { onDisk = fs.readdirSync('/d/uploads').length; } catch (e) { /* none */ }
console.log(JSON.stringify({ integrity: h.integrity, fk: h.foreign_key_problems, plainDb: dbfile.isPlainSqlite('/d/taskdesk.db'), counts, files: stored.length, missing, plain, onDisk }));
JS
RES=$(docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true -u "$OWNER" \
  -e TASKDESK_CLOUD=true -e KEYS_DIR=/k -e DATA_DIR=/d -v "$DATA:/d:ro" -v "$KEYS_DIR:/k:ro" "$IMAGE" node -e "$CHECK_JS" 2>&1)
if ! echo "$RES" | tail -n 1 | python3 -I -c 'import json,sys; json.loads(sys.stdin.read())' 2>/dev/null; then
  rollback; die "the database could not be opened and checked (wrong master.key, or damaged): $(echo "$RES" | grep -m1 -E '^[A-Za-z]*Error: |^\[(db|keys)\]' | cut -c1-240)"
fi
VERDICT=$(python3 -I - "$(echo "$RES" | tail -n 1)" "$MANIFEST" "$DB_SHA" "$DATA/taskdesk.db" <<'PY'
import hashlib, json, sys
r = json.loads(sys.argv[1]); mpath, want_sha, db = sys.argv[2], sys.argv[3], sys.argv[4]
bad = []
if r['integrity'] != 'ok': bad.append('integrity_check: ' + str(r['integrity']))
if r['fk']: bad.append('%s foreign key problems' % (len(r['fk']) if isinstance(r['fk'], list) else r['fk']))
if r['plainDb']: bad.append('the database is NOT encrypted')
if r['missing']: bad.append('%d uploaded files missing (e.g. %s)' % (len(r['missing']), ', '.join(r['missing'][:3])))
if r['plain']: bad.append('%d uploaded files are not encrypted' % len(r['plain']))
h = hashlib.sha256()
with open(db, 'rb') as f:
    for b in iter(lambda: f.read(1 << 20), b''): h.update(b)
if h.hexdigest() != want_sha: bad.append('the restored file differs from the unpacked backup')
note = ''
if mpath:
    m = json.load(open(mpath))
    if m.get('database_sha256') and m['database_sha256'] != want_sha: bad.append('the database does not match the manifest checksum')
    diff = ['%s: manifest %s, restored %s' % (t, n, r['counts'].get(t)) for t, n in m['tables'].items() if r['counts'].get(t) != n]
    diff += ['%s: not in the manifest' % t for t in r['counts'] if t not in m['tables']]
    if diff: bad.append('row counts differ: ' + '; '.join(diff[:6]))
    if m.get('files') is not None and m['files'] != r['files']: bad.append('file count %s, manifest %s' % (r['files'], m['files']))
    note = 'row counts equal the manifest (%d tables)' % len(r['counts'])
else:
    note = 'no manifest (laptop backup): counts ' + ' '.join('%s=%s' % kv for kv in r['counts'].items() if kv[0] in ('users', 'tasks', 'requests', 'messages', 'files', 'audit_log'))
extra = r['onDisk'] - r['files']
print(('BAD ' + ' | '.join(bad)) if bad else 'OK integrity ok | foreign keys ok | encrypted | %s | files %d/%d present and encrypted%s' % (note, r['files'], r['files'], (' (+%d on disk not named by the database)' % extra) if extra > 0 else ''))
PY
)
log "Checks: $VERDICT"
[ "${VERDICT%% *}" = OK ] || { rollback; die "the restored data did not pass the checks"; }

# ---- 6. desktop installers (not part of a backup)
if [ -n "$UPDATES_FROM" ]; then
  [ -n "$UPDATES" ] || die "--updates-from needs --updates <folder>"
  mkdir -p "$UPDATES" && cp -a "$UPDATES_FROM"/. "$UPDATES"/ && chown -R "$OWNER" "$UPDATES" 2>/dev/null; chmod -R u=rwX,go=rX "$UPDATES"
  log "Updates copied to $UPDATES ($(ls "$UPDATES" | wc -l) files)"
fi
trap - INT TERM
log "Restore finished. Start the app (systemctl start taskdesk). Previous data, if any: ${ASIDE:-none}"
exit 0
