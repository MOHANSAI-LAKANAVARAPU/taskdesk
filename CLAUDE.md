# TaskDesk

Root folder (`~/Downloads/TaskDesk`) holding everything for the TaskDesk project.

- `server/` — TaskDesk server (Node.js + Docker). **See `server/CLAUDE.md` for full details.**
  - Live database is in `server/data/` — never delete or overwrite it.
  - Start/stop from inside `server/`: `docker compose up -d` / `docker compose down`.
  - **Tests that can trigger emails run with the server in email dry-run mode** (record instead of send), and it is switched back afterwards, so real people never receive test emails. How: `server/CLAUDE.md` → Working rules.
- `desktop/` — Electron desktop app source (Windows and Ubuntu).
- `installers/` — built installers for employee laptops (`.exe` for Windows, `.deb` for Ubuntu).
- `backups/` — database backups. Keep each `.db`, `.db-wal` and `.db-shm` set together.
- `aws-sprint/` — IT's 8-hour AWS deployment package (unzipped, as received) plus our `DEV-worksheet.md` and `PACKAGE-REVIEW.md`. Nothing here is deployed by us.
- `old-downloads/` — original downloaded zips; not used.

- The repo is on GitHub (private): MOHANSAI-LAKANAVARAPU/taskdesk. Never make it public, never push secrets; push after each commit when I ask.
