---
tags: [taskdesk, aws, sprint, developer, worksheet]
status: filled-by-dev-not-deployed
---

# DEV worksheet - fills every DEV field of the launch worksheet

Filled from the real repository and tested on copy servers (nothing deployed to AWS, the live laptop server untouched). Rows owned by IT, SEC or the business stay **(IT)** / **(SEC)** / **(business)**. **No secret values are in this file or anywhere in the repo.** Where the package says `REPLACE_…` the answer is below.

Companion file: [PACKAGE-REVIEW.md](PACKAGE-REVIEW.md) (changes IT must make to the package).

## 1. Launch worksheet, DEV rows

| Record | Value |
|---|---|
| **Release commit / artifact / SHA-256** | Commit `c91dbce3927acc079ddb5914f9bd32795bbf333e` (`c91dbce3927a`, "AWS prep: restore reads the keys from Secrets Manager"; the last commit that changes `server/`). Artifact `taskdesk-c91dbce3927a.tar.gz`, SHA-256 `ba18791eabf81d7fef4a4336ab114fbdf976af5ecd261381610935ffa8e896c5`. Rebuild it any time, byte for byte: `server/scripts/make-release.sh c91dbce --out <dir>` (prints the SHA-256; the same commit always gives the same value). Contents: only `server/`, nothing from `.env`, keys, data, uploads, backups, installers (checked). Record the real SHA-256 again if the commit changes. |
| **Compose file** | `server/docker-compose.cloud.yml` (host path `/opt/taskdesk/current/server/docker-compose.cloud.yml`). `deployment.json` → `"compose_file"`, `"working_directory": "/opt/taskdesk/current/server"`. |
| **App service / container name** | Service `taskdesk`, container `taskdesk`. Second service `clamav`, container `taskdesk-clamav`. Compose project `taskdesk`. Image `taskdesk-taskdesk` (built on the host by `taskdesk-launch build`; Dockerfile builds the SQLCipher module, about 5-10 min). In `taskdesk.service`: `ExecStop=-/usr/bin/docker stop --time 60 taskdesk`. `deployment.json` → `"app_service": "taskdesk"`. |
| **UID:GID** | **1000:1000** (user `node` in the image, `user: "1000:1000"` in Compose). `deployment.json` → `"app_gid": "1000"` (the launcher writes the keys `root:1000`, 0640, folder 0750). ClamAV runs as its own `clamav` user inside its container. |
| **Host paths ↔ container paths** | `/srv/taskdesk/data` → `/app/data` (rw; `taskdesk.db`, `uploads/`; owner `1000:1000`, mode 700) · uploads are **inside** the data folder: `/srv/taskdesk/data/uploads` → `/app/data/uploads` · `/srv/taskdesk/updates` → `/app/updates` (read-only; desktop installers + `latest*.yml`, **not** in the release archive, IT uploads them) · `/run/taskdesk/keys` → `/run/taskdesk/keys` (read-only; `master.key`, `backup.key`, written by the launcher) · tmpfs `/tmp` 256 MB · named volume `clamav-db` → `/var/lib/clamav`. `deployment.json` → `"expected_db": "/srv/taskdesk/data/taskdesk.db"`. |
| **Backup command / output directory** | `BACKUP_COMMAND='/opt/taskdesk/current/server/scripts/backup.sh --cloud /srv/taskdesk/backup-out'` · `BACKUP_OUTPUT_DIR=/srv/taskdesk/backup-out` (create it first: `sudo install -d -m 0700 /srv/taskdesk/backup-out`) · `UPLOADS_DIR=` **empty** (the package already contains the uploads) · `REMOVE_APP_OUTPUT_AFTER_UPLOAD=no` until the restore is proven, then `yes`. Needs `docker`, `openssl`, `python3`, `flock`, `tar` on the host (all in Ubuntu 24.04 + Docker). The key is found by itself at `/run/taskdesk/keys/backup.key` (override: `BACKUP_KEY=`). Each run writes `taskdesk-backup-<UTC>.tar.enc` + `.sha256` + `manifest.json`, exits 0 only after integrity, foreign keys, row counts, every upload and an encrypt-decrypt-compare check passed, and leaves nothing on failure. |
| **Restore command (tested)** | App stopped, as root on the host: `sudo /opt/taskdesk/current/server/scripts/restore-cloud.sh <package .tar.enc, or the folder holding it> --data /srv/taskdesk/data --keys-from-secret <secret ARN> --region <primary region> --yes`. Before the first app start (workbook Step 4/6) use `--keys-from-secret` (the keys are not in `/run/taskdesk/keys` until the launcher starts the app); later `--keys-dir /run/taskdesk/keys` works. Add `--updates-from <folder with installers> --updates /srv/taskdesk/updates` to fill the updates folder in the same step. It moves any existing data to `/srv/taskdesk/data.before-restore-<time>` (never deletes), sets owner `1000:1000`, folders 700, files 600, then checks in a throw-away hardened container: opens the DB with `master.key`, `integrity_check`, foreign keys, every table's row count against the manifest, every upload present and encrypted. Exit 0 only if all pass, else the restore is undone. It also restores a **laptop backup** (`~/TaskDesk-backups/<day>`, no manifest: the counts are printed to compare with the laptop's). Tested: cloud package, real laptop backup into a fresh folder (then an app started on it), corrupt file, wrong keys, tampered manifest, running container. |
| **Health path** | `/api/health` (no sign-in, no data, `{"ok":true}` 200, or 503 when the database does not answer; never audited, rate limited or counted as activity). Set `HealthPath=/api/health` and `HealthSuccessCodes=200`. |
| **Production and rehearsal secret ARNs** | Names `taskdesk/production` and `taskdesk/rehearsal` (ARNs known only after IT/SEC create them) **(SEC)**. Shape in section 4. The rehearsal secret uses the **same keys**, a different `APP_URL`, and e-mail turned off (section 3). |
| **Final laptop backup destination / freeze window / launch owner** | Destination **(IT + business)**: an external encrypted disk (the laptop disk is 96-99% full). Freeze window and launch owner **(business)**. Command on the laptop: `cd ~/Downloads/TaskDesk/server && scripts/backup.sh --cloud /media/<external disk>/taskdesk-final` (same format as the cloud backups, restorable with `restore-cloud.sh`, same checks; it prints the row counts to record). **Order matters:** the script reads the database through the running `taskdesk` container, so take the final backup *while the container is still up* during the freeze (tell everyone to stop; the copy is consistent even online), check it exited 0, and only then run `docker compose stop taskdesk` (and start `moved-notice.js`, PACKAGE-REVIEW.md item 1). The package's "stop the laptop app, then back up" order would leave the script with nothing to read. |
| **Current desktop users / new client build** | Client **1.0.18** (released 2026-11-03; `server/updates/` and `installers/`: `TaskDesk Setup 1.0.18.exe`, `TaskDesk-1.0.18.AppImage`; laptops update by themselves within 4 hours). It keeps the laptop address until the move, then follows the server's `MOVED_TO=https://<hostname>` announcement by itself, **provided something still answers at the old address** (`server/scripts/moved-notice.js`, see PACKAGE-REVIEW.md item 1). The server does not record who runs the desktop app: 8 accounts exist today; ask each person, or check each laptop's `taskdesk.log` (`TaskDesk 1.0.18 starting` / `[move] moving from … to …`). Fresh installers that start on the new address (for new laptops, not for release to the old feed): `TASKDESK_SERVER=https://<hostname> npm run dist:win` (or `dist:linux`) in `desktop/`, silent install steps in `desktop/README.md`. |

## 2. `/etc/taskdesk/deployment.json` (DEV values)

```json
{
  "environment": "staging",
  "expected_instance_id": "(IT)",
  "region": "(IT)",
  "secret_arn": "(SEC: rehearsal first, production at cutover)",
  "working_directory": "/opt/taskdesk/current/server",
  "compose_file": "/opt/taskdesk/current/server/docker-compose.cloud.yml",
  "app_service": "taskdesk",
  "app_gid": "1000",
  "expected_db": "/srv/taskdesk/data/taskdesk.db"
}
```

`/etc/taskdesk/backup.conf`:

```bash
BACKUP_COMMAND='/opt/taskdesk/current/server/scripts/backup.sh --cloud /srv/taskdesk/backup-out'
BACKUP_OUTPUT_DIR=/srv/taskdesk/backup-out
UPLOADS_DIR=
REMOVE_APP_OUTPUT_AFTER_UPLOAD=no
```

## 3. Environment variable NAMES the app reads (no values)

All of these are named in `docker-compose.cloud.yml` as `${NAME:-default}`; the launcher gives the container **only** these. Put the ones you set in the secret's `env` object (strings only).

**Set in production (the secret's `env`):**

| Name | Meaning (default if unset) |
|---|---|
| `COOKIE_SECURE` | `true` behind HTTPS (**default in the cloud file: `true`**) |
| `APP_URL` | the company URL, `https://<hostname>`; used for every link in e-mails (empty = broken links) |
| `OWNER_EMAIL` | the owner account (an active admin); empty = nobody is treated as owner |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | Zoho mail (smtppro.zoho.com, 465, `true`); **any of host/user/pass missing = e-mail off** |

**Optional (defaults are right for today):** `MAX_UPLOAD_MB` (50) · `EMAIL_PER_MINUTE` (10) · `EMAIL_WELCOME_PER_DAY` (400, 0 = no cap) · `LOGIN_IP_LIMIT` (10; raise only if the one office address trips it) · `PASSWORD_WORKERS` (min(3, CPUs-1)) · `TRUST_PROXY` (1; see PACKAGE-REVIEW.md) · `MOVED_TO` (empty in the cloud; for a later move).

**Fixed in the Compose file (do not put in the secret):** `TZ=Asia/Kolkata`, `PORT=3000`, `DATA_DIR=/app/data`, `KEYS_DIR=/run/taskdesk/keys`, `TASKDESK_CLOUD=true`, `CLAMAV_HOST=clamav`, `CLAMAV_PORT=3310`.

**Leave unset in the cloud:** `ADMIN_NAME`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` (used only when the users table is empty; with the restored data they do nothing. If the data folder were ever empty the app would create `admin@example.com` with a default password, which is why the production guard `expected_db` must stay).

**Never in the cloud (tests only, not passed by the Compose file):** `EMAIL_DRY_RUN`, `EMAIL_OUTBOX`, `EMAIL_TEST_SPEED`, `EMAIL_TEST_FAIL`, `EMAIL_TEST_LIMIT_AFTER`, `HEALTH_TEST_FAIL`, `TASKDESK_TEST_ALLOW_HTTP_MOVE`, `SECRETS_DIR` (the laptop's name for `KEYS_DIR`). Other names that scripts read: `TASKDESK_CONTAINER`, `BACKUP_KEY`, `TASKDESK_BACKUP_DIR` (backup.sh), `AWS_CLI` (tests of restore-cloud.sh).

**Rehearsal secret:** the same `env` but `APP_URL` = the rehearsal address and **no `SMTP_PASS`** (the app then switches e-mail off completely, nothing is attempted) plus `SMTP_HOST` set to an unroutable name such as `mail.invalid` as the package asks. Leaving `SMTP_PASS` out is the stronger of the two, because without it the app never tries to connect.

## 4. Secret JSON shape (names only)

```json
{
  "env": {
    "COOKIE_SECURE": "…", "APP_URL": "…", "OWNER_EMAIL": "…",
    "SMTP_HOST": "…", "SMTP_PORT": "…", "SMTP_SECURE": "…", "SMTP_USER": "…", "SMTP_PASS": "…", "SMTP_FROM": "…",
    "MAX_UPLOAD_MB": "…", "EMAIL_PER_MINUTE": "…", "EMAIL_WELCOME_PER_DAY": "…", "LOGIN_IP_LIMIT": "…"
  },
  "master_key_b64": "…",
  "backup_key_b64": "…"
}
```

All values are strings. Only the names you actually set are needed; the rest take the defaults above.

## 5. Base64 the two keys yourself (without printing them)

The keys are the files `master.key` and `backup.key` in `~/Downloads/TaskDesk/server/secrets/` (64 hex characters and a newline each). The base64 must be of the **file bytes exactly as they are** (a new key would make all data unreadable).

Plain commands (each prints one long line; run them only where nobody is watching):

```bash
base64 -w0 < ~/Downloads/TaskDesk/server/secrets/master.key
base64 -w0 < ~/Downloads/TaskDesk/server/secrets/backup.key
```

Safer, builds the finished secret file without showing anything (needs `jq`; tested here, round trip identical to the key files):

```bash
cd ~/Downloads/TaskDesk/server
# 1. your env settings as plain JSON, e.g. {"COOKIE_SECURE":"true","APP_URL":"https://…","OWNER_EMAIL":"…","SMTP_HOST":"…"}  (write it in an editor, no keys in it)
umask 077
jq -n --rawfile m secrets/master.key --rawfile b secrets/backup.key --slurpfile e /dev/shm/taskdesk-env.json \
  '{env:$e[0], master_key_b64:($m|@base64), backup_key_b64:($b|@base64)}' > /dev/shm/taskdesk-secret.json
# 2. check it without printing: both decode to the identical key files
for k in master backup; do jq -r ".${k}_key_b64" /dev/shm/taskdesk-secret.json | base64 -d | cmp - secrets/$k.key && echo "$k ok"; done
# 3. store it (the AWS CLI reads the file; the value is never on the command line)
aws secretsmanager create-secret --name taskdesk/production --secret-string file:///dev/shm/taskdesk-secret.json --region <primary region>
# 4. remove it
shred -u /dev/shm/taskdesk-secret.json /dev/shm/taskdesk-env.json
```

`/dev/shm` is memory, so no copy of the keys lands on the laptop disk. Do the same for `taskdesk/rehearsal` with its own env file. Keep the USB copy of the keys (`server/scripts/KEYS.md`): the secret is not the only copy.

## 6. Checks I ran (copies only)

Health route · cloud Compose (config, read-only root, no capabilities, loopback port, restart `no`, uid 1000, env names, keys refused when missing or bad) · proxy chain through a real Nginx with the package's server block (client IP in the audit log, per-address lockout, `Secure` cookie, Origin/CSRF, 25 s stream heartbeat) · cloud backup + restore + a real laptop backup restored into a fresh folder and started · the 1.0.18 desktop move (26 scenarios from source, 4 from the released AppImage) · the release archive. Details: `server/CLAUDE.md`, section "Cloud (AWS prep)".
