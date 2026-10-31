#!/bin/bash
# Move TaskDesk ownership to another active admin: sets OWNER_EMAIL in server/.env, restarts the server so it takes
# effect, and logs the change (server/owner-transfers.log; the server also records it in both people's account history).
# There is deliberately no API or UI for this: it needs access to this computer. See restore.md, "If the owner leaves
# or is locked out".
#   Usage: scripts/transfer-owner.sh new.owner@company.com
# Test overrides: ENV_FILE, LOG_FILE, CHECK_DB (check this database file with local node instead of the running
# container), RESTART_CMD (instead of recreating the container).
set -euo pipefail
export PATH=/usr/local/bin:/usr/bin:/bin
DIR=$(cd "$(dirname "$0")/.." && pwd)
ENV_FILE=${ENV_FILE:-$DIR/.env}
LOG_FILE=${LOG_FILE:-$DIR/owner-transfers.log}
CONTAINER=${TASKDESK_CONTAINER:-taskdesk}
fail() { echo "Not changed: $*" >&2; exit 1; }

NEW=$(printf '%s' "${1:-}" | tr -d '[:space:]')
[ -n "$NEW" ] || { echo "Usage: $0 <email of an active admin>" >&2; exit 2; }
[[ "$NEW" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || fail "\"$NEW\" isn't a valid email."
[ -f "$ENV_FILE" ] || fail "$ENV_FILE not found."
OLD=$(grep -m1 '^OWNER_EMAIL=' "$ENV_FILE" | cut -d= -f2- || true)
if [ -n "$OLD" ] && [ "${OLD,,}" = "${NEW,,}" ]; then echo "$NEW is already the owner. Nothing changed."; exit 0; fi

# The new owner must be an active, non-removed admin (read-only check). Prints their name.
# The database is encrypted (dbfile.js opens it with the key from master.key).
CHECK='const d = require(process.env.DBFILE_MOD).openDb(process.env.DB_FILE, { readonly: true, fileMustExist: true });
const u = d.prepare("SELECT name, role, active, removed_at FROM users WHERE email = ? COLLATE NOCASE").get(process.env.NEW_EMAIL);
if (!u) { console.log("No TaskDesk account has this email."); process.exit(1); }
if (u.role !== "admin" || !u.active || u.removed_at) { console.log(`${u.name} is not an active admin (role ${u.role}${u.active ? "" : ", deactivated"}${u.removed_at ? ", removed" : ""}). Make them an admin first.`); process.exit(1); }
console.log(u.name);'
if [ -n "${CHECK_DB:-}" ]; then
  NAME=$(NEW_EMAIL="$NEW" DBFILE_MOD="$DIR/dbfile.js" DB_FILE="$CHECK_DB" node -e "$CHECK") || fail "$NAME"
else
  docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -q true || fail "the $CONTAINER container is not running (cd $DIR && docker compose up -d)."
  NAME=$(docker exec -e NEW_EMAIL="$NEW" -e DBFILE_MOD=/app/dbfile.js -e DB_FILE=/app/data/taskdesk.db "$CONTAINER" node -e "$CHECK") || fail "$NAME"
fi

# Change only the OWNER_EMAIL line (a dated copy of .env is kept next to it; it holds secrets, never commit it).
STAMP=$(date +%Y%m%d-%H%M%S)
cp -p "$ENV_FILE" "$ENV_FILE.bak-$STAMP"
if grep -q '^OWNER_EMAIL=' "$ENV_FILE"; then sed -i "s|^OWNER_EMAIL=.*|OWNER_EMAIL=$NEW|" "$ENV_FILE"
else printf '\nOWNER_EMAIL=%s\n' "$NEW" >> "$ENV_FILE"; fi
[ "$(grep -c "^OWNER_EMAIL=$NEW\$" "$ENV_FILE")" = 1 ] || { cp -p "$ENV_FILE.bak-$STAMP" "$ENV_FILE"; fail "couldn't update $ENV_FILE (put back as it was)."; }

LINE="$(date '+%F %T') owner changed from ${OLD:-nobody} to $NEW ($NAME) by ${USER:-?}@$(hostname)"
echo "$LINE" >> "$LOG_FILE"
echo "$LINE"

# Restart so the server reads the new OWNER_EMAIL (recreating the container reloads .env; the data folder is untouched).
START=$(date -u +%Y-%m-%dT%H:%M:%SZ)
if [ -n "${RESTART_CMD:-}" ]; then bash -c "$RESTART_CMD"; echo "Restarted with RESTART_CMD; check its log for \"[owner] $NAME\"."; exit 0; fi
(cd "$DIR" && docker compose up -d --force-recreate) >/dev/null 2>&1 || fail "the restart failed; .env already says $NEW. Run: cd $DIR && docker compose up -d --force-recreate"
for _ in $(seq 1 20); do
  if docker logs --since "$START" "$CONTAINER" 2>&1 | grep -q "\[owner\] $NAME (id"; then echo "Done: $NAME is now the owner."; exit 0; fi
  sleep 1
done
echo "Restarted, but the log doesn't confirm the new owner yet. Check: docker logs --tail 20 $CONTAINER" >&2
exit 1
