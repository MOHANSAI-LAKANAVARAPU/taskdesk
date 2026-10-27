# TaskDesk

Task assignment and tracking web app for managers, team leads and employees. Deployed on the company server (Docker or plain Node).

## Working rules

- **Keep it simple.** No new frameworks or build tools unless the owner asks.
- **Every permission check is enforced in `server.js`**, not only hidden in the UI. The frontend hiding a button is convenience, never security.
- **Escape all user text in the frontend** with the `esc()` helper in `public/app.js` before putting it in `innerHTML` (names, emails, titles, descriptions, messages, project names, attribute values).
- **Database changes must be safe for an existing database.** (Additive-only changes since then, e.g. teams/requests/files in 1.0.7, with a backup in `../backups/taskdesk-before-teams-2026-10-26.*`. One exception was done with care: `db.js` rebuilds the `tasks` table once at startup to allow status `submitted` — snapshot first, one transaction, row count checked, only if the old CHECK is still there. Snapshots: `data/taskdesk-before-approval-migration.db` and `../backups/taskdesk-before-approval-2026-10-26.*`.) Add columns with `ALTER TABLE ... ADD COLUMN` (guarded so it only runs once, e.g. check `PRAGMA table_info`), use `CREATE TABLE/INDEX IF NOT EXISTS`, and never drop tables/columns or delete data.
- **After every change, tell the owner which files changed and how to test it.**

## Architecture

- **Backend:** Node.js (>=18) + Express 4. [server.js](server.js) holds all routes, auth and permission logic. [db.js](db.js) opens SQLite (better-sqlite3, WAL, foreign keys ON), creates tables with `CREATE TABLE IF NOT EXISTS`, and seeds the first admin when the `users` table is empty.
- **Auth:** bcryptjs password hashes; server-side sessions in the `sessions` table; random 32-byte token in an httpOnly, SameSite=Lax cookie `sid` (30 days; `Secure` when `COOKIE_SECURE=true`). Login is rate limited in memory (10 attempts / 15 min per IP). Changing or resetting a password invalidates other sessions; deactivating a user deletes their sessions.
- **Frontend:** plain HTML/CSS/JS single-page app in [public/](public) ([index.html](public/index.html), [styles.css](public/styles.css), [app.js](public/app.js)). No frameworks, no build step. Hash routing: `#/` (dashboard), `#/tasks` (filters via query: `status`, `project`, `assignee`, `mine`), `#/tasks/:id`, `#/projects`, `#/people`, `#/account`, `#/login`. `app.js` is one IIFE with a `router()` that calls a `viewXxx()` function per page; `api()` wraps `fetch('/api' + path)` and throws on errors.
- **Static/SPA:** `express.static(public)`; unknown `/api/*` returns JSON 404; any other GET returns `index.html`.
- **Deployment:** [Dockerfile](Dockerfile) (node:20-bookworm-slim, `npm ci --omit=dev`), [docker-compose.yml](docker-compose.yml) (port 3000, `./data` and `./updates` volumes, TZ/COOKIE_SECURE; admin name/email/password come from the untracked `.env` via `env_file`, see `.env.example`). [README.md](README.md) has deployment, Nginx, backup notes.
- **Data:** SQLite file at `data/taskdesk.db` (or `$DATA_DIR`). Uploaded files in `data/uploads/` (random names; back this folder up together with the database).

### Environment variables

`PORT` (3000), `DATA_DIR` (./data), `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `ADMIN_NAME` (first start only; defaults `admin@example.com` / `ChangeMe123!`), `COOKIE_SECURE` (`true` behind HTTPS), `TZ` (decides "overdue").

## Roles and permissions (enforced in server.js)

**Managers and admins have full access to tasks and requests**: they can approve/send back any submitted task (their own too, logged as "Self-approved by <name>"), complete their own tasks directly, take any open request for any team, assign a request to any active person, and edit/reassign/delete any task at any status (deleting a task that delivered a request stays refused). Only admins can create, edit or deactivate admin accounts or grant the admin role. Team leads and employees follow the rules below.

Roles: `admin`, `manager`, `lead`, `employee`. `isBoss(u)` = admin or manager.

| Capability | admin | manager | lead | employee |
|---|---|---|---|---|
| See tasks (`taskScope`) | all | all | own tasks, tasks they assigned, tasks of members of teams they lead, tasks linked to their teams' requests | own tasks only |
| See users (`GET /api/users`) | all | all | self + members of teams they lead | self |
| Add/edit people, reset passwords, activate/deactivate | yes | yes (cannot create/grant/edit admins) | no | no |
| Create/edit projects | yes | yes | no | no |
| List projects | yes (counts limited to visible tasks for non-bosses) | yes | yes | yes |
| Assign (create) tasks | to any active user | to any active user | only active members of teams they lead, or self | no |
| Manage teams (create/rename/delete, lead, members) | yes | yes | no | no |
| Edit/delete a task (`canEditTask`) | any | any | only tasks they assigned | no |
| Self-claimed request task (assigned_by = assignee) | edit/delete (any status) | edit/delete (any status) | edit/delete if lead of the request's team; the claimer can't edit/delete, only "Give back" | claimer: "Give back" only |
| Post progress update / change status | any visible task | any visible task | tasks they are assignee of or assigned | only tasks assigned to them |

**Teams replace "Reports to".** A team's lead is `teams.lead_id` (must be an active lead/manager/admin; cleared automatically if that person becomes an employee or is deactivated). Each user has one `team_id`. `users.lead_id` stays in the database but is no longer used by the UI or by permission checks.

Other rules: a user cannot deactivate themself; only admins can create admins or modify admin accounts. Deadlines/start dates are `YYYY-MM-DD`.

**No performance scores.** The dashboard shows only counts: tasks assigned (total), completed, in progress, not started, overdue — overall, per project and per employee — plus tasks due in 7 days and completed in the last 7 days. Do not add ratings/scores/rankings.

Task status values: `assigned` (shown as "Not started"), `in_progress`, `submitted` (shown as "Waiting for approval"), `completed`. "Overdue" is derived (`status != completed` and `deadline < today`), not stored.

**Approval step (enforced in server.js, not just the UI):**
- Assignees can't mark a task Completed. They use `POST /api/tasks/:id/submit` with a required `note` → status `submitted`, `submitted_at` set. While `submitted`, the assignee (and everyone) can only add comments via `/updates`; status/progress changes return 409. `status: "submitted"` can't be set through `/updates`.
- Reviewers (`canReviewTask`): any manager/admin; the person in `assigned_by` when that isn't the assignee; and for a **self-claimed document request** (`assigned_by` = assignee, task linked to a request) the lead of the request's target team. Nobody else (other team leads can't). Leads/employees never approve their own task; a manager/admin may, and it is logged as "Self-approved by <name>" (approved_by = themselves) and shown as "(self-approved)" in History/CSV. `POST /api/tasks/:id/approve` (optional `note`) → `completed`, progress 100, `completed_at` = now, `approved_by` = reviewer. `POST /api/tasks/:id/send-back` (required `reason`) → `in_progress`, `submitted_at` cleared. Both write to the task's activity timeline ("Approved: …", "Sent back: …").
- `approversFor()` lists who can actually approve (same rules, active users only, never the assignee): the assigner, or for a self-claimed request the team's lead, plus "any manager" if another active manager/admin exists; `self` is true when the assignee is a manager/admin (they can approve it themselves, so the block below never applies to them). The task page shows "Waiting for approval from …" from this. If nobody but the assignee could approve, "Take this task", "Assign to" (to oneself) and "Submit for approval" are refused with "Nobody can approve this yet. Ask a manager to set a lead for <team>." The Teams page warns on teams without a lead.
- A plain task someone assigned to themself (`ownPlainTask`: `assigned_by` = assignee and no linked request) is completed directly via `/updates` (no approval; `submit` is refused). A self-claimed request task must be submitted. The assigner or a manager/admin may complete someone else's task directly via `/updates` (recorded as `approved_by`); a manager/admin may also complete their own task directly (logged as self-approved); nobody else can. An assignee can't move an approved task back out of Completed.
- Reassigning a submitted task resets it to `in_progress` with a note "Moved back to in progress for <name>". Reassigning a self-claimed request task makes the person reassigning its `assigned_by` (so the old claimer doesn't become its approver).
- Only `completed` tasks count as completed in dashboard totals, per-project and per-employee numbers; `submitted` is counted separately (`totals.submitted`, per person). `GET /api/dashboard` also returns `awaiting_me` (submitted tasks the current user may approve).
- Task detail returns `can_submit`, `can_review`, `can_complete_directly`, `locked`.

### Document requests

- Any user creates a request for a target team (title, details, needed-by date, optional files). The **Requests** board (`#/requests`) is visible to every signed-in user; description is visible to all, attachments and delivered files only to the requester, target-team members, the team's lead, the assignee and managers/admins.
- Status (validated in server.js, **no CHECK constraint**, so adding a status needs no table rebuild): `needs_team` (posted with "Not sure, let a manager decide", no `target_team_id`; nobody can take/assign it; a manager/admin uses "Send to team" → `POST /api/requests/:id/send-to-team {team_id}`, which sets the team, makes it `open` and logs "Sent to <team> by <name>" in `request_events`) → `open` → `assigned` (linked task created) → `delivered` (linked task approved/completed) → `closed` (requester clicks "Mark as received"). `cancelled`: requester or manager/admin, only while `needs_team` or `open`. History shows team "Not decided yet" for `needs_team`.
- "Take this task": any active member of the target team (or any manager/admin, for any team) claims an open request → linked task with assignee = assigned_by = them (approved by the team's lead or a manager). "Assign to": managers/admins and the target team's lead pick an active team member (managers/admins: any active person, list grouped by team) → linked task with assigned_by = the person who clicked. Claims are atomic (`WHERE status = 'open'`).
- "Give back" (`POST /api/tasks/:id/give-back`): the claimer of a self-claimed request task, only while the task is `assigned`/`in_progress`, removes the task and its files, sets the request back to `open` and logs "<name> gave the request back" in `request_events`. The team is notified again because the request reappears among open `team_requests` (the desktop app sees it as new if it polled while the request was taken, i.e. after about a minute).
- Reopening a completed linked task moves the request back to `assigned`; deleting the linked task of an `assigned` request puts it back to `open`; deleting the task of a delivered/closed request is refused.

### Files

- Uploads with multer (field `files`, multipart) on `POST /api/tasks/:id/updates`, `POST /api/tasks/:id/submit`, `POST /api/requests`, `POST /api/requests/:id/files`. Allowed: PDF, Word, Excel, PowerPoint, PNG/JPG/GIF/WEBP, TXT/CSV, ZIP; max 25 MB each, 5 per request. Permission checks run before the upload is parsed; any error response deletes the stored files.
- Stored in `data/uploads/` under random 32-hex names; `files` table keeps the original name. `GET /api/files/:id` needs sign-in and the same visibility as the task or request (plus: once a request is delivered, people on that request can download its task's files). Always sent as an attachment with `nosniff`.

### History

- `#/history` and `GET /api/history` (filters `person`, `team`, `status`, `from`/`to` on the creation date; `?format=csv` = CSV with UTF-8 BOM, CRLF, formula-injection guard). One row per request (with its linked task's people and dates) and one per task that isn't a request's task. Submitted date = latest "Submitted for approval" update; approved date = latest "Approved" update (or completion time for a direct completion); completed date = `completed_at` for tasks, `closed_at` (received) for requests; send-back reasons = all "Sent back: …" updates.
- Visibility: managers/admins everything; leads = their `taskScope` tasks + requests for their teams, made by their members, made by them, or whose task they can see; employees = tasks they're assigned + requests they made or whose task they did.

## Database tables ([db.js](db.js))

- **users**: id, name, email (unique, NOCASE), password_hash, role (admin|manager|lead|employee), lead_id → users, active (1/0), created_at
- **sessions**: token (PK), user_id → users (cascade), expires_at
- **projects**: id, name, description, status (active|on_hold|closed), created_by → users, created_at
- **tasks**: id, title, description, project_id → projects (SET NULL), assignee_id → users, assigned_by → users, priority (low|medium|high|urgent), status (assigned|in_progress|submitted|completed), progress (0–100), start_date, deadline, completed_at, submitted_at, approved_by → users, created_at, updated_at. Indexes on assignee_id, project_id.
- **task_updates**: id, task_id → tasks (cascade), user_id → users, message, progress, status, created_at. Activity log: progress posts, status changes, assignment/reassignment/deadline notes. Index on task_id.
- **teams**: id, name (unique, NOCASE), lead_id → users (SET NULL), created_at. "R&D", "Testing", "STQC Documentation" are created once, when the table is first created.
- **users.team_id** → teams (added with `ALTER TABLE`).
- **requests**: id, title, description, needed_by, requested_by → users, target_team_id → teams (SET NULL), status (validated in server.js), task_id → tasks (SET NULL), created_at, delivered_at, closed_at.
- **request_events**: id, request_id → requests (cascade), user_id → users, message, created_at. Request activity (currently "Sent to <team> by <name>").
- **files**: id, original_name, stored_name (random, unique), size, mime (from the extension), uploaded_by → users, task_id → tasks (cascade), update_id → task_updates, request_id → requests (cascade), created_at.

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
| GET `/api/my-summary` | signed in | `user`, `open`, `overdue`, `tasks` (own open tasks with `status`, and `sent_back_reason` after a send-back; max 100), `recently_approved` (own tasks approved in the last 3 days), `approvals` (submitted tasks waiting for this user's approval), `team_requests` (open requests for the user's team or teams they lead, not made by them), `ready_requests` (the user's own delivered requests), `needs_team_requests` (managers/admins only: requests without a team, not made by them). Used by the desktop app |
| GET `/api/teams` | signed in | Teams with lead and member count; member names for managers, the team's lead and its members |
| POST/PATCH/DELETE `/api/teams[/:id]` | boss | Add / rename + set lead / delete (refused while unfinished requests target it) |
| PUT/DELETE `/api/teams/:id/members/:userId` | boss | Add (moves from old team) / remove a member |
| GET `/api/requests` | signed in | Board; query `team`, `status` (`active` = open/assigned/delivered) |
| GET `/api/requests/:id` | signed in | Request + `can_take`, `can_assign` (+ `members`), `can_cancel`, `can_receive`, `can_attach`, `files`, `delivered_files` |
| POST `/api/requests` | signed in | New request (multipart for files) |
| POST `/api/requests/:id/take` / `assign` / `cancel` / `received` / `files` / `send-to-team` | see "Document requests" | Claim / assign to a member / cancel / mark as received / add attachments |
| GET `/api/files/:id` | see "Files" | Download |
| GET `/api/history` | signed in (scoped) | History rows; `?format=csv` for Excel |
| GET `/api/dashboard` | signed in (scoped) | `totals`, `projects`, `people`, `due_soon`, `awaiting_me` |

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
- Notifications (compared with the previous check; last statuses are stored in `config.json` as `knownStatuses` / `knownApprovalIds`): approver gets "<name> submitted '<task>' for approval"; the employee gets "'<task>' was approved" or "'<task>' was sent back: <reason>"; team members (and the team's lead) get "New document request for <team>: <title>"; the requester gets "<title> is ready"; managers/admins get "New request needs a team: <title>" (`knownNeedsTeamIds`) (request notifications open `#/requests/<id>`; tracked as `knownRequestIds` / `knownReadyIds`). Each one waves the mascot. Badge = own open tasks + tasks waiting for the user's approval.
- It talks to this server through `GET /api/my-summary` (open task count + list of the signed-in user's open tasks), used for the icon badge and new-task notifications. Keep that endpoint's response shape stable (`open`, `overdue`, `tasks`) or the desktop app breaks.
- Default server address: `http://192.168.1.222:3000`, set in the app's `package.json` under `"taskdesk.defaultServer"`.
- First-time installers for employee laptops: `../installers/` (`TaskDesk Setup <version>.exe` for Windows, `TaskDesk-<version>.AppImage` for Ubuntu; the .deb is no longer built).
- The floating tick icon is always on: users **cannot hide or quit it** (no Quit, Hide or Show-icon/Start-at-login options; `showWidget` and `autoStart` are forced to true; closing the icon window is blocked or it is recreated). It only closes on a real shutdown, restart, logout or installer/uninstaller close. The dashboard window still just hides when closed. Builds need `env -u ELECTRON_RUN_AS_NODE` if that variable is set.

### Automatic updates

- The server serves `server/updates/` publicly (no sign-in) at `/updates` (mounted into Docker as `./updates:/app/updates`, so no rebuild is needed to add versions; missing files give 404). The desktop app (electron-updater, generic provider, feed = the laptop's own server address + `/updates`) checks 1 minute after start and every 4 hours, downloads silently, then installs silently and relaunches. Update problems are only logged, never shown.
- **To release an update:** change the code in `../desktop`, bump `version` in `desktop/package.json`, run `npm run release` from `desktop/`. It builds Windows + Linux, copies the .exe, .blockmap, .AppImage, `latest.yml` and `latest-linux.yml` into `server/updates/`, copies the .exe and .AppImage into `installers/`, and deletes older versions. Laptops update within 4 hours. 
- **First-time install on Ubuntu:** run `sudo apt install libfuse2` once (AppImage needs it on Ubuntu 22.04+), copy the AppImage to `~/Applications`, `chmod +x` it, and run it once. After that it updates itself without a password.
- Windows: run `TaskDesk Setup <version>.exe` once; later versions update themselves.
