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
- **Frontend:** plain HTML/CSS/JS single-page app in [public/](public) ([index.html](public/index.html), [styles.css](public/styles.css), [app.js](public/app.js)). No frameworks, no build step. Hash routing: `#/` (dashboard), `#/tasks` (filters via query: `status`, `project`, `assignee`, `mine`), `#/tasks/:id`, `#/projects`, `#/people` (managers/admins), `#/teams`, `#/teams/:id`, `#/requests`, `#/requests/:id`, `#/history`, `#/account`, `#/login`. `#/my-team` (old) and `#/people` for non-managers redirect to `#/teams`. `app.js` is one IIFE with a `router()` that calls a `viewXxx()` function per page; `api()` wraps `fetch('/api' + path)` and throws on errors.
- **Static/SPA:** `express.static(public)`; unknown `/api/*` returns JSON 404; any other GET returns `index.html`. `.html`, `.js` and `.css` (and the SPA fallback) are sent with `Cache-Control: no-cache`, so updates show up on the next load.
- **Deployment:** [Dockerfile](Dockerfile) (node:20-bookworm-slim, `npm ci --omit=dev`), [docker-compose.yml](docker-compose.yml) (port 3000, `./data` and `./updates` volumes, TZ/COOKIE_SECURE; admin name/email/password come from the untracked `.env` via `env_file`, see `.env.example`). [README.md](README.md) has deployment, Nginx, backup notes.
- **Data:** SQLite file at `data/taskdesk.db` (or `$DATA_DIR`). Uploaded files in `data/uploads/` (random names; back this folder up together with the database).

### Branding
- Hi-Focus logo files are in `public/branding/` (served at `/branding/…`): `hifocus-banner.png` (logo on dark background) across the top of the sign-in card (max 180px high, `object-fit: cover`); in the top bar `hifocus-logo.svg` (light mode) / `hifocus-logo-white.svg` (dark mode) via `<picture>`, 28px high, then a thin divider and "TaskDesk". Below 1100px wide (and on phones) the logo box is clipped to the shield only, so the menu keeps its room; long user names in the top bar are cut short with "…" (full name on hover). The favicon stays the mascot (`/hifocus-tray.svg`).
- Desktop app: `desktop/branding/hifocus-banner.png` is inlined as a data URI at the top of `setup.html` and `offline.html` (their CSP allows `img-src data:`), so it shows without the server. The setup window is 480×500. If the banner changes, re-inline it in both files.

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
| See teams and their members (name, role, email) | yes | yes | yes | yes |
| See open task/request counts of a team | yes | yes | teams they lead | no |
| Manage teams (create/rename/delete, lead, members) | yes | yes | no | no |
| Edit/delete a task (`canEditTask`) | any | any | only tasks they assigned | no |
| Self-claimed request task (assigned_by = assignee) | edit/delete (any status) | edit/delete (any status) | edit/delete if lead of the request's team; the claimer can't edit/delete, only "Give back" | claimer: "Give back" only |
| Post progress update / change status | any visible task | any visible task | tasks they are assignee of or assigned | only tasks assigned to them |

**Teams replace "Reports to".** A team's lead is `teams.lead_id` (must be an active lead/manager/admin; cleared automatically if that person becomes an employee or is deactivated). Each user has one `team_id`. `users.lead_id` stays in the database but is no longer used by the UI or by permission checks. A person may lead more than one team.

**Teams page (everyone).** `#/teams` is a grid of team blocks (3 columns wide, 1 on phones): name, lead (managers see "⚠ No lead"), active members, and for the team's lead and managers/admins the open tasks and open requests; the user's own team comes first ("Your team"). `#/teams/:id`: lead and members (name, role, email). The team's lead also sees each member's open task count and "Assign a task" (opens the task form with that person picked); managers/admins also get Add member (type-to-search), Remove, Set lead (active leads/managers/admins, marked "already leads <team>"), Rename and Delete.

**Auto-lead (`autoLead`).** When an active user with role `lead` joins a team that has no lead — `POST /api/users` with a team, `PATCH /api/users/:id` that changes their team or role, or `PUT /api/teams/:id/members/:userId` — they become its lead; the response carries `became_lead: { team_id, team_name, name }` and the UI shows "<name> is now the lead of <team>". (A PATCH that changes neither team nor role never does this, so a lead a manager cleared on purpose stays cleared.) The People page shows "Lead of <team>" under the role, and "⚠ Not leading a team yet – set it on the Teams page" for an active role-`lead` user who leads no team.

**Team connections (1.0.12).** `team_connections` links two teams that work together (two-way, one row per pair, smaller id first). Managers/admins tick them on the team page ("Connected teams" checkboxes → `PUT /api/teams/:id/connections {team_ids}`, which replaces the team's whole list); everyone sees the list on the team page and "Works with: …" on the team blocks. Nothing is seeded: until a manager connects teams, employees can request only from their own team (or "Not sure").

Other rules: a user cannot deactivate themself; only admins can create admins or modify admin accounts. Deadlines/start dates are `YYYY-MM-DD`.

**No performance scores.** The dashboard shows only counts: tasks assigned (total), completed, in progress, not started, overdue — overall, per project and per employee — plus tasks due in 7 days and completed in the last 7 days. Do not add ratings/scores/rankings.

Task status values: `assigned` (shown as "Not started"), `in_progress`, `submitted` (shown as "Waiting for approval"), `completed`. "Overdue" is derived (`status != completed` and `deadline < today`), not stored.

**Approval step (enforced in server.js, not just the UI):**
- Assignees can't mark a task Completed. They use `POST /api/tasks/:id/submit` with a required `note` → status `submitted`, `submitted_at` set. While `submitted`, the assignee (and everyone) can only add comments via `/updates`; status/progress changes return 409. `status: "submitted"` can't be set through `/updates`.
- Reviewers (`canReviewTask`): any manager/admin; the person in `assigned_by` when that isn't the assignee; and for a **self-claimed document request** (`assigned_by` = assignee, task linked to a request) the lead of the request's target team. Nobody else (other team leads can't). Leads/employees never approve their own task; a manager/admin may, and it is logged as "Self-approved by <name>" (approved_by = themselves) and shown as "(self-approved)" in History/CSV. `POST /api/tasks/:id/approve` (optional `note`) → `completed`, progress 100, `completed_at` = now, `approved_by` = reviewer. `POST /api/tasks/:id/send-back` (required `reason`) → `in_progress`, `submitted_at` cleared. Both write to the task's activity timeline ("Approved: …", "Sent back: …").
- `approversFor()` lists who can actually approve (same rules, active users only, never the assignee): the assigner, or for a self-claimed request the team's lead, plus "any manager" if another active manager/admin exists; `self` is true when the assignee is a manager/admin (they can approve it themselves, so the block below never applies to them). The task page shows "Waiting for approval from …" from this. If nobody but the assignee could approve, "Take this task", "Assign to" (to oneself) and "Submit for approval" are refused with "Nobody can approve this yet. Ask a manager to set a lead for <team>." (`nobodyCanApprove(request, assigneeId)`; when the assignee is the team's own lead, whose work only a manager/admin can approve, it says "…Ask an admin to add a manager." instead). The Teams page warns on teams without a lead.
- A plain task someone assigned to themself (`ownPlainTask`: `assigned_by` = assignee and no linked request) is completed directly via `/updates` (no approval; `submit` is refused). A self-claimed request task must be submitted. The assigner or a manager/admin may complete someone else's task directly via `/updates` (recorded as `approved_by`); a manager/admin may also complete their own task directly (logged as self-approved); nobody else can. An assignee can't move an approved task back out of Completed.
- Reassigning a submitted task resets it to `in_progress` with a note "Moved back to in progress for <name>". Reassigning a self-claimed request task makes the person reassigning its `assigned_by` (so the old claimer doesn't become its approver).
- Only `completed` tasks count as completed in dashboard totals, per-project and per-employee numbers; `submitted` is counted separately (`totals.submitted`, per person). `GET /api/dashboard` also returns `awaiting_me` (submitted tasks the current user may approve).
- Task detail returns `can_submit`, `can_review`, `can_complete_directly`, `locked`.

### Document requests

- **Who can request from whom (`allowedTargetTeams`)**: a user may send a request to their own team and to teams connected to it; managers/admins to any team; a user without a team only "Not sure, let a manager decide". Enforced on `POST /api/requests` (403 otherwise). "Send to team" is managers/admins only, so it is never restricted. `GET /api/request-targets` gives the New request form its allowed `teams` and askable `people`.
- **Visibility (`canSeeRequest` / `requestScope`)**: a request is visible only to managers/admins, the requester, members and the lead of the requester's team (the requester's current team), members and the lead of the target team, the assignee of its task, and the person it was withdrawn from. Everyone else gets 404 and doesn't see it on the board, in History or the CSV; attachments and delivered files follow the same rule.
- **Ask a person** ("Send to: ○ A team ○ A person"): `POST /api/requests` with `person_id` (an active member of the requester's own or a connected team; managers/admins: anyone in a team; never yourself, never someone without a team). It is created already `assigned`: a linked task (assignee = the person, `assigned_by` = the requester, deadline = needed-by), `target_team_id` = the person's team, `requests.asked_person_id` = the person, and the activity "Sent to <person> by <name>". Approved by the person's team lead or a manager/admin — **never by the requester** (even a manager requester), and not by the person unless they are a manager/admin; the requester can't edit or complete it directly either. The person can "Give back" (request returns `open` to the team's board, `asked_person_id` cleared, so it is an ordinary team request again). If the lead reassigns it, the lead becomes its `assigned_by` and `asked_person_id` is cleared. Approved → `delivered` and the requester is told as usual. A lead still can't assign tasks directly to people outside the teams they lead.
- **Withdraw** (`POST /api/requests/:id/withdraw`, requester only): an `assigned` request (person or team) whose task is still `assigned`/`in_progress`. Archives the linked task (see "Archive instead of delete"), sets the request `cancelled` (`closed_at`, `withdrawn_from_id` = who had it), logs "<requester> withdrew the request". Refused once the work is submitted or delivered. Open requests are cancelled with "Cancel request" instead.
- Status (validated in server.js, **no CHECK constraint**, so adding a status needs no table rebuild): `needs_team` (posted with "Not sure, let a manager decide", no `target_team_id`; nobody can take/assign it; a manager/admin uses "Send to team" → `POST /api/requests/:id/send-to-team {team_id}`, which sets the team, makes it `open` and logs "Sent to <team> by <name>" in `request_events`) → `open` → `assigned` (linked task created) → `delivered` (linked task approved/completed) → `closed` (requester clicks "Mark as received"). `cancelled`: requester or manager/admin, only while `needs_team` or `open`. History shows team "Not decided yet" for `needs_team`.
- "Take this task" (`canTakeRequest`): any active member of the target team, the team's lead (even if not a member of it), or any manager/admin (any team) claims an open request → linked task with assignee = assigned_by = them (approved by the team's lead or a manager). "Assign to": managers/admins and the target team's lead pick an active team member (managers/admins: any active person, list grouped by team), or themself (same as taking it) → linked task with assigned_by = the person who clicked. Claims are atomic (`WHERE status = 'open'`).
- "Assign to" on an open request (target team's lead and managers/admins) is a single-person type-to-search picker: the lead sees the team's active members, managers/admins everyone (the request's team first). When they may take it, the current user is listed first as "<name> (me)" and choosing it calls `/take` (opens their new task). The lead's own work is approved by a manager/admin only, never by themself. With nobody else in the team it says "No other members in <team> yet – add them on the Teams page".
- Dashboard "Requests to assign" (`to_assign` in `GET /api/dashboard`): open requests for teams the user leads; managers/admins: all open ones plus `needs_team` ("Choose team"). "Assign" opens the same picker in a dialog.
- Reminder: `remindStaleRequests()` runs on every `GET /api/my-summary` and sets `requests.reminded_at` (once, never reset) on requests still `open` 24 hours after they became open (the later of `created_at` and the latest `request_events` entry, i.e. "Sent to team" or "gave back"). Flagged open requests are returned as `unassigned_reminders` to the team's lead and to managers/admins.
- "Give back" (`POST /api/tasks/:id/give-back`): the claimer of a self-claimed request task (or the person a request was sent to with "Ask a person"), only while the task is `assigned`/`in_progress`, archives the task, sets the request back to `open` and logs "<name> gave the request back" in `request_events`. The team is notified again because the request reappears among open `team_requests` (the desktop app sees it as new if it polled while the request was taken, i.e. after about a minute).
- Reopening a completed linked task moves the request back to `assigned`; deleting the linked task of an `assigned` request puts it back to `open`; deleting the task of a delivered/closed request is refused.

### Archive instead of delete
- Nothing is removed by everyday actions. "Delete" on a task (same permission as before: `canEditTask`), "Give back" and "Withdraw" call `archiveTask()`: they set `tasks.deleted_at`/`deleted_by` (and `archived_request_id` = the request it was linked to); the row, its updates and its files stay (files stay on disk).
- Managers/admins can also "Delete" a request (`DELETE /api/requests/:id`) while nobody is working on it (`needs_team`, `open`, `cancelled`, `closed`); it sets `requests.deleted_at`/`deleted_by` and logs "<name> deleted the request".
- Archived rows are hidden everywhere live: task lists and task pages (404), dashboard, team counts, approvals, requests board and request page (404; actions on it too), `my-summary` (so the desktop badge and notifications). `taskScope(u, archived)`, `requestScope(u, archived)` and `getRequest` (live) vs `getAnyRequest` do the filtering; any new query on `tasks` or `requests` must add `deleted_at IS NULL`.
- History (and its CSV) still lists them, to the same people as before, with status `deleted` ("Deleted", also a status filter) and "Deleted by <name> on <date>" (CSV column "Deleted"). The title is not a link.
- Managers/admins get "Restore" and "Delete permanently" (confirmation) on those History rows:
  - `POST /api/tasks/:id/restore`: clears the archive. A task that came from a request goes back on it only if the request is still waiting for it — `open` again (after a delete or give back), or `cancelled` by a withdraw from this same person — and the request becomes `assigned` again (a person request again if it was one; "Restored by <name>: <person> has it again"). If someone else took the request, it was finished, or the request is archived, restore is refused (409).
  - `POST /api/requests/:id/restore`: clears the archive ("Restored by <name>").
  - `DELETE /api/tasks/:id/permanent` / `DELETE /api/requests/:id/permanent`: only for archived rows; removes the row with its updates/activity and file rows (cascade) and deletes the stored files. A request's linked task, if any, is kept.

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
- **tasks**: id, title, description, project_id → projects (SET NULL), assignee_id → users, assigned_by → users, priority (low|medium|high|urgent), status (assigned|in_progress|submitted|completed), progress (0–100), start_date, deadline, completed_at, submitted_at, approved_by → users, created_at, updated_at, deleted_at, deleted_by → users (SET NULL), archived_request_id → requests (SET NULL) — the last three added with `ALTER TABLE` for archiving (backup `../backups/taskdesk-before-archive-2026-10-27.*`). Indexes on assignee_id, project_id.
- **task_updates**: id, task_id → tasks (cascade), user_id → users, message, progress, status, created_at. Activity log: progress posts, status changes, assignment/reassignment/deadline notes. Index on task_id.
- **teams**: id, name (unique, NOCASE), lead_id → users (SET NULL), created_at. "R&D", "Testing", "STQC Documentation" are created once, when the table is first created.
- **users.team_id** → teams (added with `ALTER TABLE`).
- **requests**: id, title, description, needed_by, requested_by → users, target_team_id → teams (SET NULL), status (validated in server.js), task_id → tasks (SET NULL), created_at, delivered_at, closed_at, reminded_at ("still unassigned" reminder sent; added with `ALTER TABLE` in 1.0.11, backup `../backups/taskdesk-before-team-blocks-2026-10-27.*`), asked_person_id → users (SET NULL; set for "Ask a person", cleared on give back/reassign) and withdrawn_from_id → users (SET NULL; who had it when the requester withdrew it), deleted_at and deleted_by → users (SET NULL; archived, added for archiving) — both added with `ALTER TABLE` in 1.0.12, backup `../backups/taskdesk-before-team-connections-2026-10-27.*`.
- **request_events**: id, request_id → requests (cascade), user_id → users, message, created_at. Request activity ("Sent to <team or person> by <name>", "<name> gave the request back", "<name> withdrew the request").
- **team_connections** (1.0.12): team_a_id, team_b_id → teams (cascade), created_by → users (SET NULL), created_at; primary key (team_a_id, team_b_id), `CHECK (team_a_id < team_b_id)`.
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
| POST `/api/users` | boss | Add person (returns `became_lead`) |
| PATCH `/api/users/:id` | boss | Edit name/email/role/lead_id/active/password |
| GET `/api/projects` | signed in | Projects with total/completed counts over visible tasks |
| POST `/api/projects` | boss | Create project |
| PATCH `/api/projects/:id` | boss | Edit name/description/status |
| GET `/api/tasks` | signed in (scoped) | List; query `status` (assigned/in_progress/completed/open/overdue), `project`, `assignee`, `mine=assigned_by_me`; max 1000 |
| POST `/api/tasks` | boss, lead (`canAssignTo`) | Create tasks: `assignee_ids` (array) creates one separate task per person, each with its own "Assigned to <name>" note; every person is checked first and if any isn't allowed nothing is created (the error names them). `assignee_id` still works. Returns `task` (first), `tasks`, `count` |
| GET `/api/tasks/:id` | if `canSeeTask` | Task + updates + `can_edit`, `can_update` |
| PATCH `/api/tasks/:id` | `canEditTask` | Edit fields / reassign |
| DELETE `/api/tasks/:id` | `canEditTask` | Delete task (archives it; kept in History) |
| POST `/api/tasks/:id/restore`, DELETE `/api/tasks/:id/permanent` | boss | Restore an archived task (back on its request if possible) / remove it for good with its files |
| DELETE `/api/requests/:id`, POST `/api/requests/:id/restore`, DELETE `/api/requests/:id/permanent` | boss | Archive a request nobody is working on / restore it / remove an archived one for good with its files |
| POST `/api/tasks/:id/updates` | assignee or `canEditTask` | Post update, change status/progress (no `completed` for assignees unless self-assigned; locked while submitted) |
| POST `/api/tasks/:id/submit` | assignee | Submit for approval (`note` required) |
| POST `/api/tasks/:id/approve` | assigner or boss (not the assignee) | Approve a submitted task (`note` optional) |
| POST `/api/tasks/:id/send-back` | assigner or boss (not the assignee) | Send back (`reason` required) |
| GET `/api/my-summary` | signed in | `user`, `open`, `overdue`, `tasks` (own open tasks with `status`, and `sent_back_reason` after a send-back; max 100), `recently_approved` (own tasks approved in the last 3 days), `approvals` (submitted tasks waiting for this user's approval), `team_requests` (open requests for the user's team or teams they lead, not made by them), `ready_requests` (the user's own delivered requests), `needs_team_requests` (managers/admins only: requests without a team, not made by them), `assign_requests` (open requests for teams the user leads), `unassigned_reminders` (open requests flagged after 24 h, for the team's lead and managers/admins), `team_asks` (requests sent straight to a member of a team the user leads; not ones they made or were asked), `withdrawn` (requests withdrawn in the last 3 days from the user or from a team they lead); `team_requests` rows carry `i_lead`; `tasks` rows carry `asked_by` (requester name) for person requests. Used by the desktop app |
| GET `/api/teams` | signed in | All teams: lead, active member count, `mine`, `can_see_counts`, `connections` (connected teams); `open_tasks`/`open_requests` only for the team's lead and managers/admins |
| GET `/api/teams/:id` | signed in | Team, `lead`, `members` (name, role, email; managers also see deactivated ones; `open_tasks` per member only for the lead and managers/admins), `can_manage`, `can_assign` |
| POST/PATCH/DELETE `/api/teams[/:id]` | boss | Add / rename + set lead / delete (refused while unfinished requests target it) |
| PUT/DELETE `/api/teams/:id/members/:userId` | boss | Add (moves from old team; returns `became_lead`) / remove a member |
| PUT `/api/teams/:id/connections` | boss | `{team_ids}`: the full list of teams this team works with |
| GET `/api/request-targets` | signed in | New request form: allowed `teams` and askable `people` (name, role, team) |
| GET `/api/requests` | signed in (scoped) | Board, only requests the user may see; query `team`, `status` (`active` = open/assigned/delivered) |
| GET `/api/requests/:id` | signed in (scoped, else 404) | Request (+ `asked_person_name`, `withdrawn_from_name`) + `can_take`, `can_assign` (+ `members`), `can_cancel`, `can_withdraw`, `can_receive`, `can_attach`, `files`, `delivered_files` |
| POST `/api/requests` | signed in | New request (multipart for files): `target_team_id` (allowed teams or `none`) or `person_id` (Ask a person) |
| POST `/api/requests/:id/take` / `assign` / `cancel` / `withdraw` / `received` / `files` / `send-to-team` | see "Document requests" | Claim / assign to a member / cancel / withdraw / mark as received / add attachments |
| GET `/api/files/:id` | see "Files" | Download |
| GET `/api/history` | signed in (scoped) | History rows, including archived ones (status `deleted`, `deleted_by_name`, `deleted_at`); `?format=csv` for Excel |
| GET `/api/version` | public | `{ build }`: hash of server.js, db.js, package.json and `public/*`; changes on every deploy. The desktop app reloads the dashboard window when it changes |
| GET `/api/dashboard` | signed in (scoped) | `totals`, `projects`, `people`, `due_soon`, `awaiting_me`, `to_assign` |

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
- Notifications (compared with the previous check; last statuses are stored in `config.json` as `knownStatuses` / `knownApprovalIds`): approver gets "<name> submitted '<task>' for approval"; the employee gets "'<task>' was approved" or "'<task>' was sent back: <reason>"; team members get "New document request for <team>: <title>", the team's lead gets "New request for <team>: <title> – assign it to someone"; the lead and managers/admins get "Still unassigned: <title>" once per request (`knownReminderIds`, only grows, max 500); the requester gets "<title> is ready"; managers/admins get "New request needs a team: <title>" (`knownNeedsTeamIds`); a person asked directly gets "<requester> asked you: <title>" (opens the task) instead of "New task assigned"; their team's lead gets "<requester> (<team>) asked <person>: <title>" (`knownAskIds`); the person and their lead get "<requester> withdrew: <title>" (`knownWithdrawnIds`; both lists only grow, max 500, and an old config.json records them silently first) (request notifications open `#/requests/<id>`; tracked as `knownRequestIds` / `knownReadyIds`). Each one waves the mascot. Badge = own open tasks + tasks waiting for the user's approval + open requests for teams the user leads (`assign_requests`) + for managers/admins requests without a team (`needs_team_requests`).
- It talks to this server through `GET /api/my-summary` (open task count + list of the signed-in user's open tasks), used for the icon badge and new-task notifications. Keep that endpoint's response shape stable (`open`, `overdue`, `tasks`) or the desktop app breaks.
- Default server address: `http://192.168.1.222:3000`, set in the app's `package.json` under `"taskdesk.defaultServer"`.
- First-time installers for employee laptops: `../installers/` (`TaskDesk Setup <version>.exe` for Windows, `TaskDesk-<version>.AppImage` for Ubuntu; the .deb is no longer built).
- The floating tick icon is always on: users **cannot hide or quit it** (no Quit, Hide or Show-icon/Start-at-login options; `showWidget` and `autoStart` are forced to true; closing the icon window is blocked or it is recreated). It only closes on a real shutdown, restart, logout or installer/uninstaller close. The dashboard window still just hides when closed. Builds need `env -u ELECTRON_RUN_AS_NODE` if that variable is set.

- After a server update: the app checks `GET /api/version` with each summary check and reloads the dashboard window (keeping the current `#route`) when the build id changes. Tray/icon "Refresh" also reloads the dashboard. Floating icon: drawn on a fixed 104×104 stage scaled to the window, badge reserved inside the top-right corner, page zoom locked to 100%; every render logs `[widget] badge "…" at x,y WxH in IWxIH page (device scale …)` when it changes, with `OUTSIDE THE WINDOW` if it doesn't fit.
- Diagnostics: the tray menu and the icon's right-click menu start with disabled lines "TaskDesk <version>" and "Last check: <time> (<n> open)" / "Last check failed: <reason>". Every summary check is logged to `~/.config/TaskDesk/taskdesk.log` (Windows: `%APPDATA%\TaskDesk\taskdesk.log`) as `[summary] ok user=… open=… approvals=… badge=…` or `[summary] failed: <reason> (HTTP <status>)`.

### Automatic updates

- The server serves `server/updates/` publicly (no sign-in) at `/updates` (mounted into Docker as `./updates:/app/updates`, so no rebuild is needed to add versions; missing files give 404). The desktop app (electron-updater, generic provider, feed = the laptop's own server address + `/updates`) checks 1 minute after start and every 4 hours, downloads silently, then installs silently and relaunches. Update problems are only logged, never shown.
- **To release an update:** change the code in `../desktop`, bump `version` in `desktop/package.json`, run `npm run release` from `desktop/`. It builds Windows + Linux, copies the .exe, .blockmap, .AppImage, `latest.yml` and `latest-linux.yml` into `server/updates/`, copies the .exe and .AppImage into `installers/`, and deletes older versions. Laptops update within 4 hours. 
- **First-time install on Ubuntu:** run `sudo apt install libfuse2` once (AppImage needs it on Ubuntu 22.04+), copy the AppImage to `~/Applications`, `chmod +x` it, and run it once. After that it updates itself without a password.
- Windows: run `TaskDesk Setup <version>.exe` once; later versions update themselves.
