---
tags: [taskdesk, aws, sprint, developer]
status: prepared-not-deployed
---

# README - Dev 8-hour sprint

**For the Developer, with IT Admin and Security Engineer on call.** This package covers only the 8 working hours needed to take TaskDesk from the laptop to AWS in India. It covers the existing app and its SQLite data, private EC2, an ALB with regional WAF, backups, alarms and a protected copy in the second India region. Everything after go-live (monitoring depth, security accounts, SSO, load testing, maintenance) is in the separate **After deployment** folder of the vault. It is deliberately not in this package.

Nothing here has been deployed or run against the real app. The templates pass `cfn-lint` for `ap-south-1` and `ap-south-2`, and the host scripts pass `shellcheck`.

## What is in this package

| File | Use |
|---|---|
| [[README - Dev 8-hour sprint]] | This page: scope, prerequisites, hour-by-hour plan, stop rules |
| [[Minimal architecture]] | What gets built, ports, where data lives, what fails when |
| [[Workbook - Fast AWS deployment]] | Step-by-step commands for each time block, launch checklist and handover table |
| `Files/taskdesk-fast.yaml` | Main CloudFormation stack: network, EC2, encrypted disks, ALB, WAF, S3, logs, alarms, daily snapshots |
| `Files/taskdesk-recovery-region.yaml` | Small stack for the **other** India region: key and bucket for recovery copies |
| `Files/taskdesk-budget.yaml` | Monthly budget alert (deploy in `ap-south-1`) |
| `Files/parameters.example.json` | Parameter file for the main stack (CLI) |
| `Files/host/` | Host files: startup loader, systemd units, backup wrapper and timer, log rotation, config examples, Compose snippet, installer |

## In scope for the 8 hours

1. Create the three stacks and confirm the host bootstrapped.
2. Deploy the real release on the host with secrets from Secrets Manager.
3. Rehearse on a copy of real data with mail disabled, then smoke-test through the ALB from the office.
4. Cut over: freeze the laptop, take a final consistent backup, restore it on EC2, start in production mode.
5. Turn on six-hourly verified app backups, daily snapshots, a copy in the other India region and secret replication.
6. Publish DNS, move the **current** users (today's office users) to the HTTPS URL.
7. Confirm alarm emails reach two people, pin the AMI, turn on termination protection.
8. Fill in the launch checklist, handover table and exceptions register.

## Not in the 8 hours (see the After deployment folder)

Isolated restore drill and measured RTO/RPO · automatic S3 replication of app backups · switching WAF from Count to Block after tuning · rate rules · HSTS · egress tightening · VPC Flow Logs · Session Manager logging · external uptime check · organization CloudTrail/GuardDuty/Security Hub and security accounts · IAM review · Zoho/Google SSO and joiner/leaver lifecycle · the 800-user load test · release pipeline · patch and reboot cadence · maintenance calendar · laptop and legacy backup disposal · the 28 security-validation cases.

**Opening TaskDesk to all employees across India (`IngressCidr` = `0.0.0.0/0`) is not part of the sprint by default.** The sprint moves today's users. Wider rollout needs the launch checklist evidence and, before all 800 users, a capacity result.

## Before the clock starts - all must be ready

If any of these items is missing, the sprint does not start. Infrastructure-only work (hours 0–1.5) can still run.

| Ready item | Owner |
|---|---|
| Workload AWS account (not the management account), primary region chosen, operator role that can create stacks and IAM roles, with MFA | IT |
| ACM certificate for the hostname **Issued** in the primary region (DNS validation can take hours, so do it the day before) | IT / DNS admin |
| DNS admin available at hour 5:45. TTL of the hostname record lowered to 300 s at least 24 h before | IT |
| Office public egress IP (for `IngressCidr`) | IT |
| Two named alert mailboxes and the monthly budget figure | IT + business |
| Release builds and runs locally at a recorded commit. You know the Compose service/container name, UID/GID, data/uploads/keys/updates mount paths and the real env-var names | DEV |
| The app's own **backup and restore commands**, tested once on a copy, plus the matching `master.key`/`backup.key` | DEV |
| Where the final laptop backup will be written (the laptop disk is 96% full, so use an external encrypted disk or a direct upload) | DEV + IT |
| Desktop plan: a client build pointing to `https://<hostname>`, and the list of current desktop users | DEV |
| A 75-minute write-freeze window agreed for the cutover, plus a named launch owner | Business owner |
| Secret values available to put into Secrets Manager (never into files, chat or this vault) | DEV + SEC |

## Hour-by-hour plan

| Time | Block | Done when |
|---|---|---|
| 0:00–0:30 | Secrets (production and mail-disabled rehearsal), recovery-region stack, budget stack, AMI lookup, instance-type availability | Secret ARNs, `RecoveryKeyArn`, AMI ID recorded |
| 0:30–1:00 | Create the main stack. While it builds (~20 min), package the release and upload it with `Files/host/` to `releases/` | `CREATE_COMPLETE` (this now means the bootstrap succeeded); outputs saved; both SNS emails confirmed |
| 1:00–1:30 | Session Manager into the host, checks, install host files, pull the release | `host-ready`, data disk mounted, agent running |
| 1:30–3:00 | **Rehearsal** on a copy of real data with the rehearsal secret: Compose edits, loader, start, local health, target healthy | App runs on EC2 with real-shaped data; no mail sent |
| 3:00–3:45 | Smoke test through the ALB from the office; WAF Count log review; IP-lockout, timezone and desktop checks; one rehearsal backup run | **Go/no-go 1** |
| 3:45–5:00 | **Cutover**: freeze the laptop, final backup, upload, restore, production mode, integrity and count checks | **Go/no-go 2**; one production writer |
| 5:00–5:45 | Backups on: first production backup, timer, manual snapshot and copy, secret replica, offsite copy of the first package | Objects visible in both India regions |
| 5:45–6:30 | DNS live; current users switch to the HTTPS URL; desktop users get the new build | Company URL works; old clients listed |
| 6:30–7:15 | Alarm test reaches both people; change set to pin the AMI and turn on protection (**no replacement**) | Change set executed |
| 7:15–8:00 | Launch checklist, handover table, exceptions register; delete the rehearsal data copy; `IngressCidr` decision | Signed by launch owner |

## Stop rules

- **Pre-sprint gate not met:** do not start the app work. Infrastructure can be created early, but it starts billing (NAT, ALB, WAF, EC2).
- **Hour 3:45, go/no-go 1 fails** (app not healthy, login/permissions/uploads broken, data unreadable with the keys): no cutover today. The laptop stays production. Continue the next day from the rehearsal.
- **During cutover, before DNS** (integrity/count mismatch, app fails on real data): stop the cloud app and restart the laptop. Nothing has been written in the cloud yet, so this is a clean rollback.
- **After users write in the cloud:** do not restart the laptop database as if it were current. Fix forward, or restore and reconcile under the launch owner's decision.
- **Running late:** cut scope in this order: desktop client rollout (browser only), then the manual snapshot copy. Never cut the backup, the restore check or the alarm test.

## Things that will bite if ignored

- **The stack is safe to update only after the AMI is pinned.** Do the 6:30 step, and always read the change set: `AppInstance` must show *Replacement: False*.
- **Expect alarm emails early.** `NoHealthyTarget` fires until the app first starts, and `BackupMissing` fires if no backup succeeds within 12 h. That is intended.
- **WAF starts in Count.** It logs and does not block, except for known bad inputs. A task containing `http://192.168.x.x` (camera/NVR links) matches the common rule set, which is why Block waits for tuning after deployment.
- **One office IP for everyone.** Check that the app's own login lockout and rate limit do not lock out the whole office (wrong `trust proxy` = every user looks like the Docker gateway).
- **UTC host.** If reminders or due dates use local time, set `TZ=Asia/Kolkata` in the container (see `Files/host/compose-cloud-snippet.example.yaml`).
- **Instance size.** `c7i.xlarge` has 8 GiB, and ClamAV holds its signatures in memory (roughly double during reloads). If the memory alarm fires, change to `m7i.xlarge` (stop/start, same data).
- **One writer only.** Never run the app on two hosts against copies of production data at the same time.

## Cost note

The stack bills from creation: one NAT gateway, ALB, WAF, EC2, EBS, public IPv4, logs, snapshots in two regions. The vault's unvalidated band for this design is about **$240–$860/month** before tax and support. Price the selected region in AWS Pricing Calculator. If the sprint is abandoned, delete the stack. The data volume, KMS keys, buckets and WAF log group are retained and still bill until removed deliberately.
