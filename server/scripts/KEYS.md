# TaskDesk encryption keys

TaskDesk keeps two keys in `~/Downloads/TaskDesk/server/secrets/`:

| File | What it locks | Needed for |
|---|---|---|
| `master.key` | Every uploaded file and the database | Running TaskDesk at all, and restoring any backup |
| `backup.key` | The backup copies in `~/TaskDesk-backups/` | Opening a backup |

Each key is one line of 64 letters and digits, made at random when TaskDesk first started.

## Losing the keys means losing the data

The keys are the only way to read the data. There is no "forgot key" option and no back door, and nobody (not even the people who wrote TaskDesk) can get the data back without them.

- Without `master.key`, the database and every uploaded file are random bytes, for good, and so is every backup.
- Without `backup.key`, the backups can't be opened.

So keep a copy of both keys somewhere other than this computer.

## Copying the keys to a USB drive

Do this once now, and again if the keys are ever replaced.

1. Plug in a USB drive you will keep only for this. Ubuntu shows it under `/media/<your user name>/<drive name>`.
2. Copy both files to it:
   ```bash
   mkdir -p "/media/$USER/<drive name>/TaskDesk-keys"
   cp ~/Downloads/TaskDesk/server/secrets/master.key ~/Downloads/TaskDesk/server/secrets/backup.key "/media/$USER/<drive name>/TaskDesk-keys/"
   ```
3. Check that the copies are identical. Both lines must say `OK`:
   ```bash
   cd ~/Downloads/TaskDesk/server/secrets && sha256sum master.key backup.key > /tmp/keys.sha256
   cd "/media/$USER/<drive name>/TaskDesk-keys" && sha256sum -c /tmp/keys.sha256 && rm /tmp/keys.sha256
   ```
4. Eject the drive from the file manager, then unplug it.
5. Keep the drive somewhere safe, **away from this computer and from the backup drive**: a locked drawer in another room, or a safe. A thief, fire or flood that takes the computer must not also take the keys.

You may make a second USB copy for a second place. Never email the keys, put them in chat, or upload them to a cloud drive.

## Putting the keys back

After a reinstall or on a new computer:

```bash
mkdir -m 700 -p ~/Downloads/TaskDesk/server/secrets
cp "/media/$USER/<drive name>/TaskDesk-keys/"*.key ~/Downloads/TaskDesk/server/secrets/
chmod 600 ~/Downloads/TaskDesk/server/secrets/*.key
```

Then restore as described in `restore.md`.

## Good to know

- The keys are made only when they're missing, and are never overwritten. `docker compose up -d` runs a short "keys" step first that checks this, then stops (`docker ps -a` shows it as "Exited (0)", which is normal).
- The folder is `chmod 700` and the files `chmod 600`, so only your user can read them. The TaskDesk container sees them read-only.
- Git ignores the folder, the Docker image leaves it out, and the backups never contain it. That is on purpose: a stolen backup is useless without the keys.
- If TaskDesk stops with `[keys] … master.key is missing`, put your USB copy back as shown above. Don't let it make a new one: a new key can't read the old data.
