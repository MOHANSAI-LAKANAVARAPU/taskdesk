# TaskDesk in the cloud (AWS prep)

What the app expects from the AWS host described in `../../aws-sprint/`. Nothing here is run by the app itself.

## Files
- `docker-compose.cloud.yml`: the only Compose file used on the host. Started by `taskdesk-launch` (systemd `taskdesk.service`) with `docker compose --env-file /dev/null`, so every setting is an **environment variable** from Secrets Manager (no `.env`, no `env_file`). Only the names listed in the file reach the app; the full list with defaults is in `../../aws-sprint/DEV-worksheet.md`.
- Services: `taskdesk` (container `taskdesk`, uid:gid 1000:1000) and `clamav` (container `taskdesk-clamav`). `restart: "no"` on both: systemd owns the lifecycle. Same hardening as the laptop (read-only root, tmpfs `/tmp`, no capabilities, no new privileges).
- The app port is published on the host's loopback only: `127.0.0.1:3000`. Nginx on the host (8443) is the only way in.

## Host folders
| Host | Container | Notes |
|---|---|---|
| `/srv/taskdesk/data` | `/app/data` | `taskdesk.db` (SQLCipher) and `uploads/`; owned `1000:1000`, mode 700 |
| `/srv/taskdesk/updates` | `/app/updates` (read-only) | desktop installers and `latest*.yml`; not in the release archive, IT uploads them |
| `/run/taskdesk/keys` | `/run/taskdesk/keys` (read-only) | `master.key`, `backup.key`; written by `taskdesk-launch` from Secrets Manager (root:1000, folder 750, files 640); in memory (`/run`), never on disk |

## Keys are never generated in the cloud
`TASKDESK_CLOUD=true` and `KEYS_DIR=/run/taskdesk/keys` are fixed in the Compose file. In that mode [keys.js](../keys.js) never creates a key: a missing or invalid `master.key` stops the server before it opens anything (`[keys] cloud mode: … is missing or unreadable`, exit 1), and the `keys` service of the laptop file does not exist. A key that is present but does not fit the database stops it too (`[db] … can't be opened with this master.key`). Never put a key in the environment or in Compose.

## Without TASKDESK_CLOUD (the laptop)
Nothing changes: `KEYS_DIR` falls back to `SECRETS_DIR`, then `server/secrets`, and missing keys are made on first run as before.
