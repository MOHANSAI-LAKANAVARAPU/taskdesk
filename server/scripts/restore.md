# Restoring TaskDesk from a backup

Backups are made by `scripts/backup.sh`, every day at 13:00 and 18:00 (when the laptop is on). Each one is saved in `~/TaskDesk-backups/YYYY-MM-DD/` as one encrypted file:

- `taskdesk-backup.tar.enc`: the database (`taskdesk.db`, one file, no `-wal`/`-shm` needed) and all attached files (`uploads/`), packed together and encrypted with `server/secrets/backup.key`.
- `taskdesk-backup.tar.enc.sha256`: a checksum, to spot a damaged file.

Backups made before 31 Oct 2026 are plain folders with `taskdesk.db` and `uploads/` directly inside; for those, skip step 2b.

The newest 14 days are kept. The log is `~/TaskDesk-backups/backup.log`.

**The keys.** A backup file is locked with `server/secrets/backup.key`, and inside it the database and the files are still locked with `server/secrets/master.key`. Restoring needs both, the same keys that were in use when the backup was made; the keys are never inside a backup. If this computer's keys are gone, put back the USB copy first (`KEYS.md`).

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

## 2b. Decrypt the backup

This unpacks the backup into a temporary folder. What comes out is still encrypted with `master.key`, so nothing readable lands on the disk.

```bash
DAY=2026-10-28
cd ~/TaskDesk-backups/$DAY && sha256sum -c taskdesk-backup.tar.enc.sha256     # must say OK
mkdir -m 700 /tmp/taskdesk-restore-$DAY
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -md sha256 \
  -pass file:$HOME/Downloads/TaskDesk/server/secrets/backup.key \
  -in ~/TaskDesk-backups/$DAY/taskdesk-backup.tar.enc | tar -x -C /tmp/taskdesk-restore-$DAY
ls /tmp/taskdesk-restore-$DAY                                                # taskdesk.db  uploads
```

`bad decrypt` means the wrong `backup.key`: put back the USB copy (`KEYS.md`).

In step 3, use `BACKUP=/tmp/taskdesk-restore-$DAY`. For an older plain backup use `BACKUP=$HOME/TaskDesk-backups/$DAY`. Delete the temporary folder after the restore (`rm -r /tmp/taskdesk-restore-$DAY`).

## 3. Swap in the backup

The files in `data/` belong to root. So the commands run inside the TaskDesk image, which can move them without `sudo`. The current data is moved to `data/before-restore-<date-time>/`; nothing is deleted.

```bash
cd ~/Downloads/TaskDesk/server
BACKUP=/tmp/taskdesk-restore-2026-10-28      # from step 2b
docker run --rm -v "$PWD/data:/data" -v "$BACKUP:/backup:ro" taskdesk-taskdesk sh -c '
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
2. Put both keys from the USB drive into `server/secrets/` (`KEYS.md`, "Putting the keys back"). Without them the backup can't be opened, and the server would refuse to start.
3. Decrypt the backup as in step 2b, and put its `taskdesk.db` and `uploads/` into `server/data/`.
4. Run `docker compose up -d --build`.
5. If the server's address changes, laptops need the new address. Use the tray menu → "Change server address…".

## If the owner leaves or is locked out

The owner account is set on the server by `OWNER_EMAIL` in `server/.env`. Nobody else can change it, including other admins. There is no way to move ownership in the app or the API. It needs access to this computer.

- **Move ownership to another person.** They must already be an **active admin** in TaskDesk, so make them an admin first if needed. Then run:
  `~/Downloads/TaskDesk/server/scripts/transfer-owner.sh new.owner@hifocuscctv.com`

  The script:
  - checks the person is an active admin;
  - changes only the `OWNER_EMAIL` line in `.env`, keeping a dated copy `.env.bak-<time>`;
  - restarts the container, which leaves the data untouched;
  - writes a line to `server/owner-transfers.log`.

  The server also records the change in both people's Account history. If the person isn't an active admin, nothing changes.
- **The owner forgot their password.** They can use "Forgot password?" on the sign-in page, which sends a link to their own email. Nobody else can reset it.
- **The owner's email has to change.** Stop the server and change the email in the database and `OWNER_EMAIL` in `.env` together. Or move ownership to another admin first, let them change the email, then move it back.
- **`OWNER_EMAIL` matches no active admin.** This happens if it's empty, mistyped, or the person was made a non-admin by editing the database. The server logs `[owner] WARNING: …` at startup and treats nobody as owner. The normal admin rules then apply, so nobody is locked out. Fix `.env` and restart with `docker compose up -d --force-recreate`.
- Never put the `.env` copies or the log into git (`.gitignore` covers them). They contain the email password.

## Notes

- Never delete `server/data/`. Old `before-restore-*` folders can be removed once you're sure you don't need them.
- A backup can be checked at any time without touching the server. Decrypt it as in step 2b, then check the database inside the TaskDesk image with the key. It should print `ok 0` and the number of people:
  ```bash
  cd ~/Downloads/TaskDesk/server
  docker run --rm -v "/tmp/taskdesk-restore-2026-10-28:/backup:ro" -v "$PWD/secrets:/app/secrets:ro" -e SECRETS_DIR=/app/secrets taskdesk-taskdesk \
    node -e "const f=require('/app/dbfile'),d=f.openDb('/backup/taskdesk.db',{readonly:true,fileMustExist:true}),h=f.health(d);console.log(h.integrity,h.foreign_key_problems,d.prepare('SELECT COUNT(*) n FROM users').get().n)"
  ```
- The usual `sqlite3` tool can't open the database (it's encrypted). To look inside, use the image as above, with `require('/app/dbfile').openDb(…)`.
- If the laptop is off at 13:00 and 18:00, that day has no backup (cron doesn't catch up). Run `~/Downloads/TaskDesk/server/scripts/backup.sh` by hand when needed.
