# TaskDesk

Root folder (`~/Downloads/TaskDesk`) holding everything for the TaskDesk project.

- `server/` — TaskDesk server (Node.js + Docker). **See `server/CLAUDE.md` for full details.**
  - Live database is in `server/data/` — never delete or overwrite it.
  - Start/stop from inside `server/`: `docker compose up -d` / `docker compose down`.
- `desktop/` — Electron desktop app source (Windows and Ubuntu).
- `installers/` — built installers for employee laptops (`.exe` for Windows, `.deb` for Ubuntu).
- `backups/` — database backups. Keep each `.db`, `.db-wal` and `.db-shm` set together.
- `old-downloads/` — original downloaded zips; not used.
