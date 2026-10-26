# TaskDesk

Task assignment and tracking web app for managers, team leads and employees. Deployed on the company server (Docker or plain Node).

## Working rules

- **Keep it simple.** No new frameworks or build tools unless the owner asks.
- **Every permission check is enforced in `server.js`**, not only hidden in the UI. The frontend hiding a button is convenience, never security.
- **Escape all user text in the frontend** with the `esc()` helper in `public/app.js` before putting it in `innerHTML` (names, emails, titles, descriptions, messages, project names, attribute values).
- **Database changes must be safe for an existing database.** (One exception was done with care: `db.js` rebuilds the `tasks` table once at startup to allow status `submitted` — snapshot first, one transaction, row count checked, only if the old CHECK is still there. Snapshots: `data/taskdesk-before-approval-migration.db` and `../backups/taskdesk-before-approval-2026-10-26.*`.) Add columns with `ALTER TABLE ... ADD COLUMN` (guarded so it only runs once, e.g. check `PRAGMA table_info`), use `CREATE TABLE/INDEX IF NOT EXISTS`, and never drop tables/columns or delete data.
- **After every change, tell the owner which files changed and how to test it.**

## Architecture

- **Backend:** Node.js (>=18) + Express 4. [server.js](server.js) holds all routes, auth and permission logic. [db.js](db.js) opens SQLite (better-sqlite3, WAL, foreign keys ON), creates tables with `CREATE TABLE IF NOT EXISTS`, and seeds the first admin when the `users` table is empty.
- **Auth:** bcryptjs password hashes; server-side sessions in the `sessions` table; random 32-byte token in an httpOnly, SameSite=Lax cookie `sid` (30 days; `Secure` when `COOKIE_SECURE=true`). Login is rate limited in memory (10 attempts / 15 min per IP). Changing or resetting a password invalidates other sessions; deactivating a user deletes their sessions.
- **Frontend:** plain HTML/CSS/JS single-page app in [public/](public) ([index.html](public/index.html), [styles.css](public/styles.css), [app.js](public/app.js)). No frameworks, no build step. Hash routing: `#/` (dashboard), `#/tasks` (filters via query: `status`, `project`, `assignee`, `mine`), `#/tasks/:id`, `#/projects`, `#/people`, `#/account`, `#/login`. `app.js` is one IIFE with a `router()` that calls a `viewXxx()` function per page; `api()` wraps `fetch('/api' + path)` and throws on errors.
- **Static/SPA:** `express.static(public)`; unknown `/api/*` returns JSON 404; any other GET returns `index.html`.
- **Deployment:** [Dockerfile](Dockerfile) (node:20-bookworm-slim, `npm ci --omit=dev`), [docker-compose.yml](docker-compose.yml) (port 3000, `./data` volume, env for admin/TZ/COOKIE_SECURE). [README.md](README.md) has deployment, Nginx, backup notes.
- **Data:** SQLite file at `data/taskdesk.db` (or `$DATA_DIR`).

### Environment variables

`PORT` (3000), `DATA_DIR` (./data), `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `ADMIN_NAME` (first start only; defaults `admin@example.com` / `ChangeMe123!`), `COOKIE_SECURE` (`true` behind HTTPS), `TZ` (decides "overdue").

## Roles and permissions (enforced in server.js)

Roles: `admin`, `manager`, `lead`, `employee`. `isBoss(u)` = admin or manager.

| Capability | admin | manager | lead | employee |
|---|---|---|---|---|
| See tasks (`taskScope`) | all | all | own tasks, tasks they assigned, tasks of people whose `lead_id` = them | own tasks only |
| See users (`GET /api/users`) | all | all | self + direct reports | self |
| Add/edit people, reset passwords, activate/deactivate | yes | yes (cannot create/grant/edit admins) | no | no |
| Create/edit projects | yes | yes | no | no |
| List projects | yes (counts limited to visible tasks for non-bosses) | yes | yes | yes |
| Assign (create) tasks | to any active user | to any active user | only active users with `lead_id` = self, or self | no |
| Edit/delete a task (`canEditTask`) | any | any | only tasks they assigned | no |
| Post progress update / change status | any visible task | any visible task | tasks they are assignee of or assigned | only tasks assigned to them |

Other rules: a user cannot deactivate themself or be their own lead; `lead_id` must reference a user with role lead/manager/admin; only admins can create admins or modify admin accounts. Deadlines/start dates are `YYYY-MM-DD`.

**No performance scores.** The dashboard shows only counts: tasks assigned (total), completed, in progress, not started, overdue — overall, per project and per employee — plus tasks due in 7 days and completed in the last 7 days. Do not add ratings/scores/rankings.

Task status values: `assigned` (shown as "Not started"), `in_progress`, `submitted` (shown as "Waiting for approval"), `completed`. "Overdue" is derived (`status != completed` and `deadline < today`), not stored.

**Approval step (enforced in server.js, not just the UI):**
- Assignees can't mark a task Completed. They use `POST /api/tasks/:id/submit` with a required `note` → status `submitted`, `submitted_at` set. While `submitted`, the assignee (and everyone) can only add comments via `/updates`; status/progress changes return 409. `status: "submitted"` can't be set through `/updates`.
- Reviewers (`canReviewTask`): the person in `assigned_by`, or any manager/admin, but never the assignee themself. `POST /api/tasks/:id/approve` (optional `note`) → `completed`, progress 100, `completed_at` = now, `approved_by` = reviewer. `POST /api/tasks/:id/send-back` (required `reason`) → `in_progress`, `submitted_at` cleared. Both write to the task's activity timeline ("Approved: …", "Sent back: …").
- If `assigned_by` = assignee (`selfAssigned`) they complete directly via `/updates` (no approval; `submit` is refused). The assigner/boss may also complete someone else's task directly via `/updates` (recorded as `approved_by`). An assignee can't move an approved task back out of Completed.
- Reassigning a submitted task resets it to `in_progress`.
- Only `completed` tasks count as completed in dashboard totals, per-project and per-employee numbers; `submitted` is counted separately (`totals.submitted`, per person). `GET /api/dashboard` also returns `awaiting_me` (submitted tasks the current user may approve).
- Task detail returns `can_submit`, `can_review`, `can_complete_directly`, `locked`.

## Database tables ([db.js](db.js))

- **users**: id, name, email (unique, NOCASE), password_hash, role (admin|manager|lead|employee), lead_id → users, active (1/0), created_at
- **sessions**: token (PK), user_id → users (cascade), expires_at
- **projects**: id, name, description, status (active|on_hold|closed), created_by → users, created_at
- **tasks**: id, title, description, project_id → projects (SET NULL), assignee_id → users, assigned_by → users, priority (low|medium|high|urgent), status (assigned|in_progress|submitted|completed), progress (0–100), start_date, deadline, completed_at, submitted_at, approved_by → users, created_at, updated_at. Indexes on assignee_id, project_id.
- **task_updates**: id, task_id → tasks (cascade), user_id → users, message, progress, status, created_at. Activity log: progress posts, status changes, assignment/reassignment/deadline notes. Index on task_id.

## API endpoints ([server.js](server.js))

All except login require the session cookie (`auth`). Errors are `{ error: "..." }`.

| Method & path | Access | Purpose |
|---|---|---|
| POST `/api/login` | public | Sign in (rate limited), sets `sid` cookie |
| POST `/api/logout` | any | End session |
| GET `/api/me` | signed in | Current user |
| POST `/api/me/password` | signed in | Change own password (`current`, `next` ≥ 8 chars) |
| GET `/api/users` | signed in (scoped by role) | List users |
| POST `/api/users` | boss | Add person |
| PATCH `/api/users/:id` | boss | Edit name/email/role/lead_id/active/password |
| GET `/api/projects` | signed in | Projects with total/completed counts over visible tasks |
| POST `/api/projects` | boss | Create project |
| PATCH `/api/projects/:id` | boss | Edit name/description/status |
| GET `/api/tasks` | signed in (scoped) | List; query `status` (assigned/in_progress/completed/open/overdue), `project`, `assignee`, `mine=assigned_by_me`; max 1000 |
| POST `/api/tasks` | boss, lead (`canAssignTo`) | Create task |
| GET `/api/tasks/:id` | if `canSeeTask` | Task + updates + `can_edit`, `can_update` |
| PATCH `/api/tasks/:id` | `canEditTask` | Edit fields / reassign |
| DELETE `/api/tasks/:id` | `canEditTask` | Delete task |
| POST `/api/tasks/:id/updates` | assignee or `canEditTask` | Post update, change status/progress (no `completed` for assignees unless self-assigned; locked while submitted) |
| POST `/api/tasks/:id/submit` | assignee | Submit for approval (`note` required) |
| POST `/api/tasks/:id/approve` | assigner or boss (not the assignee) | Approve a submitted task (`note` optional) |
| POST `/api/tasks/:id/send-back` | assigner or boss (not the assignee) | Send back (`reason` required) |
| GET `/api/my-summary` | signed in | `user`, `open`, `overdue`, `tasks` (own open tasks with `status`, and `sent_back_reason` after a send-back; max 100), `recently_approved` (own tasks approved in the last 3 days), `approvals` (submitted tasks waiting for this user's approval). Used by the desktop app |
| GET `/api/dashboard` | signed in (scoped) | `totals`, `projects`, `people`, `due_soon` |

## Run locally

```bash
npm install
npm start            # http://localhost:3000
```

First start creates the admin from `ADMIN_EMAIL` / `ADMIN_PASSWORD` (defaults `admin@example.com` / `ChangeMe123!`), e.g.:

```bash
ADMIN_EMAIL=admin@test.com ADMIN_PASSWORD='TestPass123!' npm start
```

To reset a dev database, stop the server and delete `data/` (dev only — never on the production server). Docker: `docker compose up -d --build`. There is no test suite; test by running the app and exercising the UI/API as each role.

## Desktop app (Electron, Windows and Ubuntu)

- Source lives in `../desktop` (sibling folder of `server/`; dependencies not installed yet — run `npm install` there only when needed).
- Notifications (compared with the previous check; last statuses are stored in `config.json` as `knownStatuses` / `knownApprovalIds`): approver gets "<name> submitted '<task>' for approval"; the employee gets "'<task>' was approved" or "'<task>' was sent back: <reason>"; each one waves the mascot. Badge = own open tasks + tasks waiting for the user's approval.
- It talks to this server through `GET /api/my-summary` (open task count + list of the signed-in user's open tasks), used for the icon badge and new-task notifications. Keep that endpoint's response shape stable (`open`, `overdue`, `tasks`) or the desktop app breaks.
- Default server address: `http://192.168.1.222:3000`, set in the app's `package.json` under `"taskdesk.defaultServer"`.
- First-time installers for employee laptops: `../installers/` (`TaskDesk Setup <version>.exe` for Windows, `TaskDesk-<version>.AppImage` for Ubuntu; the .deb is no longer built).
- The floating tick icon is always on: users **cannot hide or quit it** (no Quit, Hide or Show-icon/Start-at-login options; `showWidget` and `autoStart` are forced to true; closing the icon window is blocked or it is recreated). It only closes on a real shutdown, restart, logout or installer/uninstaller close. The dashboard window still just hides when closed. Builds need `env -u ELECTRON_RUN_AS_NODE` if that variable is set.
- `server.js.old` in this folder is the pre-`/api/my-summary` version, kept as a rollback copy.

### Automatic updates

- The server serves `server/updates/` publicly (no sign-in) at `/updates` (mounted into Docker as `./updates:/app/updates`, so no rebuild is needed to add versions; missing files give 404). The desktop app (electron-updater, generic provider, feed = the laptop's own server address + `/updates`) checks 1 minute after start and every 4 hours, downloads silently, then installs silently and relaunches. Update problems are only logged, never shown.
- **To release an update:** change the code in `../desktop`, bump `version` in `desktop/package.json`, run `npm run release` from `desktop/`. It builds Windows + Linux, copies the .exe, .blockmap, .AppImage, `latest.yml` and `latest-linux.yml` into `server/updates/`, copies the .exe and .AppImage into `installers/`, and deletes older versions. Laptops update within 4 hours. 
- **First-time install on Ubuntu:** run `sudo apt install libfuse2` once (AppImage needs it on Ubuntu 22.04+), copy the AppImage to `~/Applications`, `chmod +x` it, and run it once. After that it updates itself without a password.
- Windows: run `TaskDesk Setup <version>.exe` once; later versions update themselves.
