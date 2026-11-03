---
tags: [taskdesk, aws, sprint, review]
status: dev-review-not-deployed
---

# Package review: what IT must change, checked against the real app

I read the whole sprint package (README, Minimal architecture, Workbook, `Files/host/*`, the Nginx, ALB, WAF, backup and alarm parts of `taskdesk-fast.yaml`) and tried the parts that touch the app on copy servers: a real Nginx with the package's server block in front of a copy server, the package's backup-wrapper logic, the launcher's compose handling and the keys layout. Nothing was deployed to AWS. Each item says whether it was **tested here** or **read from the template/AWS docs**.

Companion file: [DEV-worksheet.md](DEV-worksheet.md) (all DEV answers, env names, secret shape).

## A. Changes IT must make (in priority order)

### 1. Old desktop apps are stranded when the laptop is stopped (Workbook Steps 6 and 8) - *read, app side tested*
The workbook stops the laptop app at cutover and says old clients "point at the laptop and will not find the cloud on their own". Both ways an installed app can learn the new address, and its auto-update (to 1.0.18, which knows how to follow), come **from the laptop server's own address**.
**Change:** after the final backup, instead of leaving the laptop silent, run the database-free notice server there (it never opens the database or keys):
```bash
cd ~/Downloads/TaskDesk/server && MOVED_TO=https://<company hostname> node scripts/moved-notice.js     # port 3000, serves /updates from server/updates
```
Keep it running for weeks, until `taskdesk.log` on the stragglers shows `[move] moving from … to …`. Add to Step 6 (after "stop the laptop app") and to the Step 10 handover row "Laptop state". Release 1.0.18 (done, in `server/updates/`) **before** the cutover and give laptops about 4 hours to update.

### 2. Nginx upload limit: `client_max_body_size 55m` (taskdesk-fast.yaml, backend Nginx block) - *tested here*
The app accepts **5 files per request, each up to `MAX_UPLOAD_MB` (50 MB)**, i.e. up to about 250 MB per request. Through the package's Nginx block, 3 files of 20 MB (60 MB) already fail with `413 Request Entity Too Large`; 5 x 49 MB fails too.
**Change** in the `location /` / `server` block:
```nginx
client_max_body_size 260m;        # 5 files x 50 MB + form overhead; if MAX_UPLOAD_MB changes: 5 x MAX_UPLOAD_MB + 10
client_body_timeout 120s;
...
location / {
  ...
  proxy_request_buffering off;    # stream uploads to the app (and ClamAV) instead of spooling up to 250 MB on the root disk
```
With these lines, 3 x 20 MB and 5 x 49 MB uploads went through the same Nginx block and were stored (tested; `proxy_buffering off`, `proxy_read_timeout 600s` and the rest of the block stay as they are).

### 3. Workbook Step 4/6: the keys do not exist yet when the restore runs - *tested here*
`taskdesk-launch start` is what writes `/run/taskdesk/keys`; Steps 4 and 6 restore the data **before** the first start. The app's restore script therefore reads the keys from the secret itself.
**Change** the "REPLACE: the app's verified restore command" lines (Step 4.3 and Step 6.4) to:
```bash
sudo /opt/taskdesk/current/server/scripts/restore-cloud.sh /srv/taskdesk/restore-in \
  --data /srv/taskdesk/data --keys-from-secret <rehearsal or production secret ARN> --region ap-south-1 \
  --updates-from /srv/taskdesk/updates-in --updates /srv/taskdesk/updates --yes     # drop the two updates options if not uploaded yet
```
It replaces the separate `chown` line (it sets `1000:1000`, folders 700, files 600) and checks the result (integrity, foreign keys, row counts against the manifest, every upload present and encrypted); exit 0 only if all pass, otherwise it puts the previous data back. In Step 6 use `/srv/taskdesk/restore-final` and the production ARN. Step 6.2's "run the app's integrity check and record row counts" is done by the laptop backup itself (it prints the counts).

### 4. Workbook Step 6 order: the laptop backup needs the laptop app **running** - *tested here*
Step 6 says stop the laptop app, then take the final backup. The app's backup reads the encrypted database **through the running container** (a consistent online copy), so it cannot run against a stopped one.
**Change:** announce the freeze, take the backup while the container is up (nobody writes during the freeze), check it exited 0 and printed `Verify: OK`, **then** `docker compose stop taskdesk`, then start the notice server (item 1):
```bash
cd ~/Downloads/TaskDesk/server && scripts/backup.sh --cloud /media/<external disk>/taskdesk-final
```

### 5. Health check parameters (Steps 4.7, 9 and the stack) - *tested here*
Set `HealthPath=/api/health` and `HealthSuccessCodes=200` (a stack update through the change set of Step 9, `AppInstance` must stay `Replacement: False`). The route needs no login, returns only `{"ok":true}`, answers 503 when the database does not answer, and is never audited or rate limited.

### 6. `updates/` is not in the release archive - *tested here*
The archive (from `git archive`) deliberately holds no installers, so `/srv/taskdesk/updates` is empty and the HTTPS update endpoint 404s until IT fills it.
**Change:** add to Step 2/3: upload `latest.yml`, `latest-linux.yml`, `TaskDesk Setup <ver>.exe`, its `.blockmap` and `TaskDesk-<ver>.AppImage` from the laptop's `server/updates/` to `s3://…/releases/updates/`, and on the host `sudo install -d -m 0755 /srv/taskdesk/updates && sudo aws s3 cp --recursive s3://…/releases/updates/ /srv/taskdesk/updates/` (or use `--updates-from` of item 3). The checklist row "clients use the HTTPS update endpoint" needs it.

### 7. Backup disk and S3 sizing - *computed from the scripts and template defaults*
Each app backup package contains **a full copy of the uploads** (database + uploads, encrypted), and the wrapper then tars that again before uploading. Transient disk use at each run is about **3 x the size of `data/`**; `DataDiskGiB` (200) therefore supports about 60 GB of data. S3 keeps 4 packages a day for `BackupRetainDays` (default 35) = **140 full copies**: at 10 GB of data that is 1.4 TB. Today's data is about 1 MB, so none of this bites at the sprint, but record it in the exceptions register. Cheaper options later: incremental uploads, or `UPLOADS_DIR=/srv/taskdesk/data/uploads` with a database-only package (needs an app change, not done), and a shorter `BackupRetainDays`. Set `REMOVE_APP_OUTPUT_AFTER_UPLOAD=yes` once a restore has worked, or `/srv/taskdesk/backup-out` keeps every package.

### 7b. Password links appear in ALB access logs (Step 2 stack, `AlbLogs`) - *read from the app code and AWS behaviour*
The page opens a set-password link by calling `GET /api/password/check?token=…`. The WAF log already redacts the query string (`RedactedFields: QueryString`), Nginx logs no URLs, but **ALB access logs record the request URL including the query string**, so valid welcome (48 h) and reset (1 h) tokens are readable in the S3 logs by whoever can read that bucket until they are used. Tokens are single use and stored hashed in the app. Short term: restrict the `alb/` log bucket to SEC and keep the log retention short; record as an exception. Proper fix is app-side (move the token to a POST body): not done, tell me if you want it.

## B. Check before switching WAF from Count to Block (not a sprint change)

All of the following is from the AWS managed-rule documentation (read here, not tried): in `AWSManagedRulesCommonRuleSet`
- **`GenericRFI_BODY` / `GenericRFI_QUERYARGUMENTS`** match `http://`, `https://`, `ftp://`, `file://` followed by an **IPv4 address**. TaskDesk tasks, requests and chat routinely carry camera/NVR links such as `http://192.168.1.64/`. In Block mode these requests (`POST /api/tasks`, `/api/tasks/:id/updates`, `/api/requests`, `/api/chat/*/messages`) would be refused. This is already what the package expects ("a task containing http://192.168.x.x matches").
- **`RestrictedExtensions_QUERYARGUMENTS`** blocks query arguments with `.log`, `.ini`, and similar: the app's search boxes (`?q=` on tasks, requests, history, chat search) would refuse a search for `error.log`.
- **`CrossSiteScripting_BODY`** and the SQLi rule set match code, markup and SQL-like words that engineers paste into notes and chat (`<script>`, `select … from`).
- **`SizeRestrictions_BODY`** matches every body over 8 KB: file uploads (up to 250 MB), the 2 MB bulk-import JSON, long chat text. The package already overrides it to Count; **keep that override** (ALB inspection is fixed at 8 KB, oversize handling `Continue`, so a large upload is never inspected beyond its first 8 KB anyway).
- `NoUserAgent_HEADER`: the browser and the desktop app (Chromium/Electron and Node `fetch`) send a User-Agent; check in the Count log that desktop requests (`/api/version`, `/api/my-summary`, `/api/stream`, `/updates/…`) show no match.
- `/updates/<installer>` URLs end in `.exe`/`.AppImage`: check in the Count log that `RestrictedExtensions_URIPATH` does not match them.
- `AWSManagedRulesKnownBadInputsRuleSet` **already blocks today** (it is not in Count): its `Log4JRCE_*`, `JavaDeserializationRCE_*` and `Host_localhost_HEADER` rules would refuse a chat message or task text that contains `${jndi:…}` or a Java `Runtime…exec` pattern. Rare, but know it.

**Recommended when tuning:** keep the body rules (`GenericRFI_BODY`, `CrossSiteScripting_BODY`, SQLi body rules) in Count permanently, or add a scope-down that excludes `/api/tasks*`, `/api/requests*`, `/api/chat/*`, `/api/users/import/*`, `/api/files*` and `/updates/*`; block only the URI-path, header and cookie variants. Also add `x-csrf-token` to the WAF log's `RedactedFields` next to `authorization` and `cookie` (it is an HMAC of the session token; low risk, free to hide).

## C. Memory, disk and instance size - *measured on the app, template read*

Measured on the app (600-user load test, Docker): Node app 100-150 MB (peak about 300 MB), ClamAV about 950 MiB at start and about twice that for a moment when signatures reload (every 2 hours), under 3% CPU at 1 upload a second. Add Nginx, the CloudWatch agent, Docker and Ubuntu (about 1 GB) and the one-off `npm ci` compile during `taskdesk-launch build` (about 1 GB, before the app runs).
- **Steady about 2.5-3 GB, short peaks about 4-5 GB: `c7i.xlarge` (8 GiB) is enough for today's users and for the 600-user profile I tested**; the `MemoryAlarm` (`mem_used_percent`, excludes page cache) should stay quiet. `m7i.xlarge` (16 GiB) is a margin choice, not a need, and remains the right switch if the alarm does fire or before 800 users.
- CPU: the app used about 25% of one core at 600 users (84% for the one-minute sign-in rush), so 4 vCPU is ample.
- ClamAV needs about 20 s to a few minutes after each start; until then uploads answer 503 "scanner isn't running", while the app and `/api/health` stay up. Test the Step 5 EICAR row only after `[scan] ClamAV ready` appears in `docker logs taskdesk`.
- Root volume is 30 GiB (`taskdesk-fast.yaml`): Docker images (node build stage about 1.2 GB, ClamAV about 1.5 GB, the app) and build cache fit, but run `docker builder prune -f` after the first build if the root disk alarm (80%) fires.

## D. Verified OK (no change needed)

- **Real client address and HTTPS** - *tested through a real Nginx with the package's block:* with `X-Forwarded-For: $remote_addr` and `X-Forwarded-Proto https` the app records the real client in the audit log; the per-address sign-in limit and the account lockout treat each client separately (12 failures from one address block only that address); a forged first `X-Forwarded-For` entry is ignored because the ALB appends the real address and Nginx's `real_ip_recursive on` picks it; `Secure` cookies work with `COOKIE_SECURE=true`; the Origin/CSRF check passes with `Host` = the company name and refuses another site. App setting `TRUST_PROXY=1` (default, one hop = Docker's gateway). Everyone in the office shares one address, so the failure-only limit `LOGIN_IP_LIMIT` (10) matters: successful sign-ins reset it, 100 sign-ins at the same moment are fine.
- **Live updates (SSE)** - *tested through Nginx:* `/api/stream` writes `: ping` every 25 s (seen at 26 s and 51 s idle). The ALB idle timeout is 300 s and Nginx `proxy_read_timeout` 600 s, `keepalive_timeout` 310 s, `proxy_buffering off` and the app's `X-Accel-Buffering: no`: well inside. Browsers and the desktop app reconnect after 5 s.
- **Keys** - *tested:* the launcher's layout (`/run/taskdesk/keys`, root:1000, folder 750, files 640) is readable by the container's uid/gid 1000; in cloud mode the app never creates keys, and refuses to start when they are missing or wrong (tested: empty folder, only `backup.key`, bad `master.key`, another key).
- **Compose variables** - *tested:* `docker compose --env-file /dev/null` passes only the names listed in `docker-compose.cloud.yml`; everything else in the secret's `env` is ignored. The names are in the DEV worksheet.
- **Timezone** - `TZ=Asia/Kolkata` is set in the Compose file (the host stays UTC; the backup timer is UTC as documented).
- **Compose lifecycle** - `up --abort-on-container-exit` ends the whole stack if ClamAV exits; `Restart=always` in `taskdesk.service` then restarts both. Fine for a single host; check `service.log` if the app restarts every 15 s.
- **Release archive** - *tested:* only `server/`, no `.env`, keys, data, uploads, backups, installers; image builds from the extracted archive (`.env.example` and `updates/README.txt` are the only matches for those names); same commit = same SHA-256.

## E. What I changed in the app for the package (all committed as "AWS prep: …")

`/api/health` · `docker-compose.cloud.yml` + cloud-only key handling (`KEYS_DIR`, `TASKDESK_CLOUD`) · `TRUST_PROXY` · `scripts/backup.sh --cloud` and `scripts/restore-cloud.sh` · desktop 1.0.18 (`MOVED_TO`, `moved.js`, `scripts/moved-notice.js`) · `scripts/make-release.sh`. The live laptop server has **not** been rebuilt with any of it: that happens once, after a normal backup, before the move (the released 1.0.18 desktop works against the old server unchanged).
