#!/bin/bash
# Release archive for the AWS host (AWS prep): the server/ folder of ONE git commit, made with `git archive`, so it holds only
# what is committed: never .env, keys, data, uploads, backups, installers or desktop builds. The same commit always gives the
# same bytes (git archive stamps files with the commit time; gzip -n).
#
#   scripts/make-release.sh [<commit>=HEAD] [--out <directory>=aws-sprint/out]
#
# Prints the commit, the file count, the size and the SHA-256 (also written to <archive>.sha256 in sha256sum format). The archive
# is taskdesk-<12-char commit>.tar.gz with server/ at its top, the name and layout the sprint workbook expects
# (/opt/taskdesk/releases/<commit>/server, working_directory /opt/taskdesk/current/server). Fails (and removes the archive) if any
# forbidden path is inside. Warns about uncommitted changes under server/ (they are NOT in the archive).
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(git -C "$HERE" rev-parse --show-toplevel) || { echo "make-release.sh: not inside a git repository" >&2; exit 2; }
COMMIT=HEAD; OUT="$ROOT/aws-sprint/out"; GOT_COMMIT=0
while [ $# -gt 0 ]; do
  case "$1" in
    --out) [ $# -ge 2 ] || { echo "make-release.sh: --out needs a directory" >&2; exit 2; }; OUT=$2; shift 2 ;;
    --out=*) OUT=${1#--out=}; shift ;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "make-release.sh: unknown option $1" >&2; exit 2 ;;
    *) [ "$GOT_COMMIT" = 0 ] || { echo "make-release.sh: one commit only" >&2; exit 2; }; COMMIT=$1; GOT_COMMIT=1; shift ;;
  esac
done
FULL=$(git -C "$ROOT" rev-parse --verify --quiet "$COMMIT^{commit}") || { echo "make-release.sh: '$COMMIT' is not a commit in this repository" >&2; exit 2; }
SHORT=${FULL:0:12}
git -C "$ROOT" cat-file -e "$FULL:server/server.js" 2>/dev/null || { echo "make-release.sh: commit $SHORT has no server/ folder" >&2; exit 2; }
mkdir -p "$OUT"; OUT=$(cd "$OUT" && pwd)
ARCHIVE="$OUT/taskdesk-$SHORT.tar.gz"
TMP=$(mktemp "$OUT/.taskdesk-$SHORT.XXXXXX")
trap 'rm -f "$TMP" "$TMP.list"' EXIT

if [ -n "$(git -C "$ROOT" status --porcelain --untracked-files=no -- server)" ]; then
  echo "WARNING: server/ has uncommitted changes; the archive holds commit $SHORT exactly as committed." >&2
fi

# Explicit exclusions on top of "only what is committed" (belt and braces), then a check of what actually went in.
git -C "$ROOT" archive --format=tar "$FULL" -- server \
  ':(exclude,glob)server/.env' ':(exclude,glob)server/.env.bak*' ':(exclude)server/secrets' ':(exclude)server/data' \
  ':(exclude)server/node_modules' ':(exclude)server/owner-transfers.log' \
  | gzip -n -9 > "$TMP"
tar -tzf "$TMP" > "$TMP.list"

FORBIDDEN='(^|/)\.env($|\.(?!example$))|(^|/)\.env\.bak|(^|/)secrets(/|$)|\.key$|(^|/)data(/|$)|(^|/)uploads(/|$)|(^|/)backups(/|$)|(^|/)installers(/|$)|(^|/)node_modules(/|$)|\.(db|db-wal|db-shm|sqlite|sqlite3)$|\.(exe|AppImage|deb|blockmap|msi)$|owner-transfers\.log$|^server/updates/(?!README\.txt$)[^/]'
BAD=$(grep -P "$FORBIDDEN" "$TMP.list" || true)
if [ -n "$BAD" ]; then echo "FAILED: the archive would contain forbidden paths:" >&2; echo "$BAD" | head -20 >&2; exit 1; fi
for must in server/server.js server/package.json server/package-lock.json server/Dockerfile server/docker-compose.cloud.yml server/keys.js; do
  grep -qx "$must" "$TMP.list" || { echo "FAILED: $must is missing from the archive (is it committed?)" >&2; exit 1; }
done

mv "$TMP" "$ARCHIVE"; chmod 644 "$ARCHIVE"
( cd "$OUT" && sha256sum "taskdesk-$SHORT.tar.gz" > "taskdesk-$SHORT.tar.gz.sha256" )
SHA=$(cut -d' ' -f1 "$ARCHIVE.sha256")
FILES=$(grep -vc '/$' "$TMP.list" || true)
echo "commit:   $FULL"
echo "subject:  $(git -C "$ROOT" log -1 --format=%s "$FULL")"
echo "archive:  $ARCHIVE"
echo "files:    $FILES"
echo "size:     $(du -h "$ARCHIVE" | cut -f1) ($(stat -c %s "$ARCHIVE") bytes)"
echo "sha256:   $SHA"
if ! git -C "$ROOT" branch -r --contains "$FULL" 2>/dev/null | grep -q .; then echo "note:     commit $SHORT is not on any remote branch (no push needed for the archive, but record the commit id)"; fi
