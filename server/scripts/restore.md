# Restoring TaskDesk from a backup

Backups are made by `scripts/backup.sh`, every day at 13:00 and 18:00 (when the laptop is on). Each one is saved in `~/TaskDesk-backups/YYYY-MM-DD/`:

- `taskdesk.db`: the whole database, in one file (no `-wal`/`-shm` needed).
- `uploads/`: all attached files.

The newest 14 days are kept. The log is `~/TaskDesk-backups/backup.log`.

Restoring puts the whole system back to the moment of that backup. Anything done after it is lost: tasks, requests, chat messages, files and passwords. The current data is moved aside first, never deleted, so you can go back.

## 1. Choose the backup

```bash
ls ~/TaskDesk-backups/
grep 'Verify' ~/TaskDesk-backups/backup.log | tail -n 20
```

Pick a day whose `Verify:` line starts with `OK`. The commands below use `2026-10-28` as the example; change it to your day.

## 2. Stop the server

```bash
cd ~/Downloads/TaskDesk/server
docker compose down
```

## 3. Swap in the backup

The files in `data/` belong to root. So the commands run inside the TaskDesk image, which can move them without `sudo`. The current data is moved to `data/before-restore-<date-time>/`; nothing is deleted.

```bash
cd ~/Downloads/TaskDesk/server
DAY=2026-10-28
docker run --rm -v "$PWD/data:/data" -v "$HOME/TaskDesk-backups/$DAY:/backup:ro" taskdesk-taskdesk sh -c '
  set -e
  test -f /backup/taskdesk.db
  keep=/data/before-restore-$(date +%Y%m%d-%H%M%S)
  mkdir "$keep"
  for f in taskdesk.db taskdesk.db-wal taskdesk.db-shm uploads; do [ -e "/data/$f" ] && mv "/data/$f" "$keep/"; done
  cp /backup/taskdesk.db /data/taskdesk.db
  cp -r /backup/uploads /data/uploads
  echo "Restored. The old data is in data/$(basename "$keep")"'
```

If it says `Unable to find image 'taskdesk-taskdesk'`, the image has a different name. Run `docker compose build` once, then try again.

## 4. Start the server and check

```bash
docker compose up -d
docker logs --tail 5 taskdesk          # should end with "TaskDesk running on http://localhost:3000"
curl -s http://localhost:3000/api/version
```

Sign in at http://192.168.1.222:3000 and look at a few recent tasks, requests and chats.

**Sign-ins:**
- People who signed in after the backup may have to sign in again.
- Passwords are back to what they were at the backup.

**Desktop app:** it reconnects by itself within a minute.

## Going back (undo the restore)

Stop the server again (`docker compose down`). Then move the set-aside data back into place, using the same image:

```bash
cd ~/Downloads/TaskDesk/server
OLD=before-restore-20261028-083000   # the folder name printed in step 3 (its time is in UTC)
docker run --rm -v "$PWD/data:/data" taskdesk-taskdesk sh -c "
  set -e
  test -f /data/$OLD/taskdesk.db
  mkdir /data/undone-restore-\$(date +%Y%m%d-%H%M%S) && mv /data/taskdesk.db* /data/uploads /data/undone-restore-*/
  mv /data/$OLD/* /data/ && rmdir /data/$OLD"
docker compose up -d
```

## Restoring on another computer

1. Copy the server folder (code, `.env`, `docker-compose.yml`) and one backup day to the new computer.
2. Put the backup's `taskdesk.db` and `uploads/` into `server/data/`.
3. Run `docker compose up -d --build`.
4. If the server's address changes, laptops need the new address. Use the tray menu → "Change server address…".

## Notes

- Never delete `server/data/`. Old `before-restore-*` folders can be removed once you're sure you don't need them.
- A backup can be checked at any time without touching the server:
  `python3 -c "import sqlite3; print(sqlite3.connect('file:$HOME/TaskDesk-backups/2026-10-28/taskdesk.db?immutable=1', uri=True).execute('PRAGMA integrity_check').fetchone())"`
- If the laptop is off at 13:00 and 18:00, that day has no backup (cron doesn't catch up). Run `~/Downloads/TaskDesk/server/scripts/backup.sh` by hand when needed.
