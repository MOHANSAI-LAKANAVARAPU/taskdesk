---
tags: [taskdesk, aws, workbook, deployment, fast, sprint]
status: prepared-not-deployed
---

# Workbook - Fast AWS deployment

Step-by-step commands for the 8-hour sprint in [[README - Dev 8-hour sprint]]. The architecture is in [[Minimal architecture]]. Region examples use Mumbai `ap-south-1` as primary and Hyderabad `ap-south-2` as recovery; swap them if IT chooses Hyderabad as primary.

**Conventions:** run AWS CLI commands from CloudShell or an operator workstation using the approved MFA role, unless the step says **on the host** (a Session Manager shell on the EC2). Replace every `REPLACE_` value. Never put secret values, keys, cookies or tokens in this note, in files in this package or in chat. Record **ARNs/IDs only**.

## Step 0 — Before the sprint clock starts

Every item in the README's "Before the clock starts" table must be ready. Then fill the worksheet below.

### Launch worksheet

| Record | Value / reference | Owner |
|---|---|---|
| Account ID / primary region / recovery region | Fill | IT |
| Hostname / DNS provider / DNS admin / TTL lowered on | Fill | IT |
| ACM certificate ARN (status **Issued**) | Fill | IT |
| Office egress IP for `IngressCidr` | Fill | IT |
| Primary and second alert mailboxes / monthly budget | Fill | IT |
| VPC/subnet CIDRs checked for overlap with office/VPN | Fill (defaults 10.70.0.0/16) | IT |
| Instance type / data disk GiB (measured DB + uploads + updates + working space) | Fill | DEV + IT |
| Release commit / artifact name / SHA-256 | Fill | DEV |
| Compose file / app service / container name / UID:GID | Fill | DEV |
| Host paths ↔ container paths for data, uploads, updates, keys | Fill | DEV |
| Backup command / output directory / restore command (tested) | Fill | DEV |
| Production and rehearsal secret ARNs (no values) | Fill | DEV + SEC |
| Final laptop backup destination / freeze window / launch owner | Fill | DEV + business |
| Current desktop users / new client build version | Fill | DEV |

## Step 1 — Secrets, recovery storage and budget (0:00–0:30)

**1.1 Production and rehearsal secrets (DEV + SEC).** Console: **Secrets Manager → Store a new secret → Other type → Plaintext**, in the primary region. Use the JSON shape in `Files/host/secret.example.json`:

- `env`: the app's real environment variable names and values, as strings, including `COOKIE_SECURE` if the app reads it.
- `master_key_b64` / `backup_key_b64`: base64 of the **existing** `master.key` / `backup.key` bytes. New keys would make the existing data unreadable.

Name them `taskdesk/production` and `taskdesk/rehearsal`. The rehearsal secret has the **same keys** but the app's real SMTP host variable points to an unroutable value, so the rehearsal copy cannot email employees. Record both ARNs.

**1.2 Recovery-region stack (IT).**

```bash
aws cloudformation deploy --region ap-south-2 --stack-name taskdesk-recovery \
  --template-file Files/taskdesk-recovery-region.yaml
aws cloudformation describe-stacks --region ap-south-2 --stack-name taskdesk-recovery \
  --query 'Stacks[0].Outputs' --output table
```

Record `RecoveryKeyArn` and `RecoveryBucketName`.

**1.3 Budget stack (IT).** Deploy it in `ap-south-1` whichever region is primary, because CloudFormation has no budget resource in Hyderabad. Use `BudgetUnit=INR` if the Billing console shows INR.

```bash
aws cloudformation deploy --region ap-south-1 --stack-name taskdesk-budget \
  --template-file Files/taskdesk-budget.yaml \
  --parameter-overrides MonthlyBudget=REPLACE BudgetUnit=USD \
    NotificationEmail=REPLACE SecondNotificationEmail=REPLACE
```

**1.4 Pin the image and check instance availability (IT).**

```bash
aws ssm get-parameter --region ap-south-1 \
  --name /aws/service/canonical/ubuntu/server/noble/stable/current/amd64/hvm/ebs-gp3/ami-id \
  --query Parameter.Value --output text
aws ec2 describe-availability-zones --region ap-south-1 --query 'AvailabilityZones[0].ZoneName' --output text
aws ec2 describe-instance-type-offerings --region ap-south-1 --location-type availability-zone \
  --filters Name=instance-type,Values=c7i.xlarge,m7i.xlarge,m6i.xlarge \
  --query 'InstanceTypeOfferings[].[InstanceType,Location]' --output table
```

The stack places the EC2 in the **first** AZ listed. Choose an instance type offered there.

- [ ] Secrets, recovery stack, budget stack, AMI ID recorded.

## Step 2 — Create the main stack (0:30–1:00)

**IT. This creates paid resources.** Copy `Files/parameters.example.json` to a private working copy, fill it (`PinnedAmiId` from 1.4, `RecoveryKeyArn` from 1.2), then:

```bash
aws cloudformation create-stack --region ap-south-1 --stack-name taskdesk-prod \
  --template-body file://Files/taskdesk-fast.yaml \
  --parameters file://parameters.json --capabilities CAPABILITY_IAM \
  --tags Key=Application,Value=TaskDesk Key=Environment,Value=Production \
         Key=Owner,Value=REPLACE Key=CostCenter,Value=REPLACE
aws cloudformation wait stack-create-complete --region ap-south-1 --stack-name taskdesk-prod
aws cloudformation describe-stacks --region ap-south-1 --stack-name taskdesk-prod \
  --query 'Stacks[0].Outputs' --output table
```

Console alternative: **CloudFormation → Create stack → Upload a template file**, the same parameters and the same tags.

- `CREATE_COMPLETE` now includes a successful host bootstrap (`BootstrapWait`). If the bootstrap fails, the stack rolls back with the failing line in the reason. Termination protection is off for this first create, so rollback works.
- **Retry after a failure:** a retained `aws-waf-logs-…` log group carries a unique suffix and will not block a retry. The retained data volume, KMS key and buckets from a failed attempt still bill, so delete them deliberately once you are sure they hold no data.
- Both operators must click **Confirm subscription** in the SNS emails.
- Expect a `NoHealthyTarget` alarm email shortly. Nothing is running yet.

While the stack builds (DEV), package the release and upload the host files:

```bash
git -C REPLACE_REPO archive --format=tar.gz -o taskdesk-REPLACE_COMMIT.tar.gz REPLACE_COMMIT
sha256sum taskdesk-REPLACE_COMMIT.tar.gz            # record it
aws s3 cp taskdesk-REPLACE_COMMIT.tar.gz s3://REPLACE_TRANSFER_BUCKET/releases/
aws s3 cp --recursive Files/host/ s3://REPLACE_TRANSFER_BUCKET/releases/host/
```

The archive must not contain `.env`, keys, the database, uploads or backups. If the project ships a tested image instead, record its digest and use the existing image process.

- [ ] Stack complete; outputs recorded in the handover table; both subscriptions confirmed.

## Step 3 — Check the host and install host files (1:00–1:30)

**EC2 → instance → Connect → Session Manager.** On the host:

```bash
sudo cloud-init status --wait
sudo test -f /var/lib/taskdesk/host-ready && echo host-ready
findmnt /srv/taskdesk
sudo docker compose version && sudo nginx -t
systemctl is-active amazon-cloudwatch-agent taskdesk-backend-cert.timer
aws sts get-caller-identity
sudo aws s3 cp --recursive s3://REPLACE_TRANSFER_BUCKET/releases/host/ /root/taskdesk-host/
sudo bash /root/taskdesk-host/install-host-files.sh
REL=REPLACE_COMMIT
sudo aws s3 cp s3://REPLACE_TRANSFER_BUCKET/releases/taskdesk-$REL.tar.gz /root/
sha256sum /root/taskdesk-$REL.tar.gz                # must match the recorded value
sudo install -d -m 0750 /opt/taskdesk/releases/$REL
sudo tar -xzf /root/taskdesk-$REL.tar.gz -C /opt/taskdesk/releases/$REL
sudo ln -sfn /opt/taskdesk/releases/$REL /opt/taskdesk/current
```

- [ ] Host ready, data disk mounted, host files installed, release in `/opt/taskdesk/current`.

## Step 4 — Rehearse on a copy of the real data (1:30–3:00)

**DEV.** Goal: prove the app runs on EC2 with real-shaped data **before** freezing the laptop.

1. **Take a rehearsal backup on the laptop** with the app's own backup procedure. Write it to the external disk, because the laptop disk is nearly full. The laptop stays live.
2. Upload it from an operator machine: `aws s3 cp REHEARSAL_BACKUP s3://REPLACE_TRANSFER_BUCKET/restore/rehearsal/`
3. **On the host**, fetch it and restore with the app's restore procedure into the real persistent paths. Then set ownership to the container UID:GID:

```bash
sudo install -d -m 0700 /srv/taskdesk/restore-in
sudo aws s3 cp --recursive s3://REPLACE_TRANSFER_BUCKET/restore/rehearsal/ /srv/taskdesk/restore-in/
# REPLACE: the app's verified restore command into /srv/taskdesk/data (and uploads/updates paths)
sudo chown -R REPLACE_UID:REPLACE_GID /srv/taskdesk/data   # only the app's own directories
```

4. **Make the cloud Compose variant.** Start from the real Compose file and apply `compose-cloud-snippet.example.yaml`: loopback port `127.0.0.1:3000:3000`, `restart: "no"` on every service, real mounts, env pass-through, and `TZ=Asia/Kolkata` only if the app uses local time. Keep ClamAV and the existing non-root/read-only settings.
5. **Fill `/etc/taskdesk/deployment.json`**: `"environment": "staging"`, the instance ID, the region, the **rehearsal** secret ARN, the working directory, the Compose file, the app service, the numeric GID and the expected DB path. Get the instance ID with:

```bash
TOKEN=$(curl -fsS -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token)
curl -fsS -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/instance-id
```

Replace `REPLACE_ACTUAL_APP_CONTAINER` in `/etc/systemd/system/taskdesk.service`, then:

```bash
sudo /usr/local/sbin/taskdesk-launch validate
sudo /usr/local/sbin/taskdesk-launch build        # skip if using a pre-built image
sudo systemctl daemon-reload && sudo systemctl start taskdesk
sudo tail -n 50 /var/log/taskdesk/service.log
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/   # or the readiness path
aws elbv2 describe-target-health --region ap-south-1 --target-group-arn REPLACE_TARGET_GROUP_ARN
```

6. **Proxy settings:** the app must see HTTPS and the real client IP (Express `trust proxy` limited to the local proxy hop). Set the company HTTPS base URL. Remove any hard-coded laptop HTTP URLs.
7. **Health check:** if DEV adds a readiness route (for example `/api/health` that checks the database, needs no login and returns no data), update `HealthPath` and set `HealthSuccessCodes=200` in Step 9's change set.

- [ ] Rehearsal app running, target **healthy**, no mail sent.

## Step 5 — Smoke-test through the ALB, then go/no-go (3:00–3:45)

From the office network (allowed by `IngressCidr`), test through the real hostname before DNS exists:

```bash
curl --connect-to 'REPLACE_HOSTNAME:443:REPLACE_ALB_DNS:443' -sS -o /dev/null -w '%{http_code}\n' https://REPLACE_HOSTNAME/
curl -sk -o /dev/null -w '%{http_code}\n' https://REPLACE_ALB_DNS/      # expect 404: unknown hosts rejected
```

For browser testing, add a **temporary** hosts-file entry for the hostname pointing to one current ALB IP (`dig +short REPLACE_ALB_DNS`). Remove it afterwards.

| Check | Pass |
|---|---|
| Login, logout, admin/manager 2FA, wrong-team task not visible (UI and direct API) | ✔ |
| Create → assign → submit → approve a **synthetic** task; chat; SSE live updates | ✔ |
| Upload at the size limit; authorized download; ClamAV rejects the EICAR test file | ✔ |
| Five failed logins on a test account lock only that account; others from the same office IP still log in | ✔ |
| Due-date/reminder times match the laptop (timezone) | ✔ |
| A task containing `http://192.168.1.64/` saves (WAF Count) and shows in the WAF log as a match | ✔ / note |
| Desktop client (new build) signs in and receives live updates | ✔ |

WAF matches (CloudWatch Logs Insights, WAF log group):

```text
fields @timestamp, httpRequest.uri, ruleGroupList
| filter @message like /COUNT/
| sort @timestamp desc
| limit 50
```

Run one rehearsal backup: fill `/etc/taskdesk/backup.conf`, then `sudo systemctl start taskdesk-backup.service` and check `/var/log/taskdesk/backup.log`. Objects appear under `backups/staging/`.

**Go/no-go 1 (launch owner):** all rows pass, or a failure has an owner and does not affect data/access. Otherwise stop. The laptop stays production.

## Step 6 — Cut over the live data (3:45–5:00)

**DEV + IT; launch owner decides.**

1. Announce the freeze. **Stop the laptop app** so no writes happen; keep the laptop and its data unchanged.
2. Take the **final** consistent backup with the app's procedure to the external disk. Run the app's integrity check and record row counts for the main tables and the attachment count.
3. Upload: `aws s3 cp FINAL_BACKUP s3://REPLACE_TRANSFER_BUCKET/restore/final/`
4. On the host:

```bash
sudo systemctl stop taskdesk
sudo mv /srv/taskdesk/data /srv/taskdesk/rehearsal-data       # deleted in Step 10
sudo install -d -m 0700 /srv/taskdesk/restore-final
sudo aws s3 cp --recursive s3://REPLACE_TRANSFER_BUCKET/restore/final/ /srv/taskdesk/restore-final/
# REPLACE: the app's verified restore command into /srv/taskdesk/data (and uploads/updates); then chown as in Step 4
```

5. Edit `/etc/taskdesk/deployment.json`: `"environment": "production"` and the **production** secret ARN. Then `sudo systemctl start taskdesk`. In production mode the loader refuses to start if the expected DB is missing or empty.
6. Verify the integrity check, counts equal to the laptop's, admin login and one representative real task and attachment.

**Go/no-go 2:** counts match and the app works. If not, stop the cloud app and restart the laptop. That rollback is clean while no one has written in the cloud.

- [ ] Exactly one production writer (EC2). Laptop app stopped, data kept.

## Step 7 — Turn on backups and recovery copies (5:00–5:45)

```bash
# On the host: first production backup, then the six-hourly timer (00/06/12/18 UTC = 05:30/11:30/17:30/23:30 IST)
sudo systemctl start taskdesk-backup.service && sudo tail -n 5 /var/log/taskdesk/backup.log
sudo systemctl enable --now taskdesk-backup.timer && systemctl list-timers taskdesk-backup.timer

# Operator: confirm the objects (the host role cannot list backups/)
aws s3 ls --recursive s3://REPLACE_TRANSFER_BUCKET/backups/production/ | tail -n 3

# Operator: immediate post-cutover snapshot and its copy to the recovery region
SNAP=$(aws ec2 create-snapshot --region ap-south-1 --volume-id REPLACE_DATA_VOLUME_ID \
  --description "taskdesk post-cutover" --query SnapshotId --output text)
aws ec2 wait snapshot-completed --region ap-south-1 --snapshot-ids "$SNAP"
aws ec2 copy-snapshot --region ap-south-2 --source-region ap-south-1 --source-snapshot-id "$SNAP" \
  --encrypted --kms-key-id REPLACE_RECOVERY_KEY_ARN --description "taskdesk post-cutover copy"

# Operator: offsite copy of the first app backup package (until automatic replication exists)
aws s3 cp --recursive --source-region ap-south-1 --region ap-south-2 \
  s3://REPLACE_TRANSFER_BUCKET/backups/production/REPLACE_STAMP/ \
  s3://REPLACE_RECOVERY_BUCKET/backups/production/REPLACE_STAMP/

# Operator: replicate the production secret to the recovery region
aws secretsmanager replicate-secret-to-regions --region ap-south-1 \
  --secret-id REPLACE_PRODUCTION_SECRET_ARN --add-replica-regions Region=ap-south-2
```

The snapshot wait can take a while for a large disk. Start the copy and continue. The daily snapshot policy runs at 02:00 IST and copies automatically when `RecoveryKeyArn` was set. SEC confirms the offline/break-glass copy of the SQLCipher keys under the company process.

- [ ] Backup object in primary, package and snapshot copy in recovery region, secret replica **InSync**.

## Step 8 — Publish DNS and move current users (5:45–6:30)

**IT (DNS) + DEV.**

1. Route 53: an **A alias** to the ALB. Other DNS providers: a **CNAME** from the hostname to `AlbDnsName`. Never use an IP address. TTL 300.
2. Verify from the office:

```bash
curl -sI http://REPLACE_HOSTNAME/ | head -n 3              # 301 to https
curl -sS -o /dev/null -w '%{http_code}\n' https://REPLACE_HOSTNAME/
openssl s_client -connect REPLACE_HOSTNAME:443 -servername REPLACE_HOSTNAME </dev/null 2>/dev/null \
  | openssl x509 -noout -subject -enddate
```

3. Current users: give them the new HTTPS URL. Desktop users install the new client build. List anyone still on an old client, because old clients point at the laptop and will not find the cloud on their own.

- [ ] Company URL works with a valid certificate and redirect.

## Step 9 — Alerts, pinning and protection (6:30–7:15)

```bash
# Both recipients must show a real subscription ARN, not PendingConfirmation
aws sns list-subscriptions-by-topic --region ap-south-1 --topic-arn REPLACE_ALERT_TOPIC_ARN \
  --query 'Subscriptions[].[Endpoint,SubscriptionArn]' --output table

# Alarm states: NoHealthyTarget and BackupMissing should now be OK
aws cloudwatch describe-alarms --region ap-south-1 --alarm-name-prefix taskdesk-prod \
  --query 'MetricAlarms[].[AlarmName,StateValue]' --output table

# Delivery test: both people must receive it (resets at the next evaluation)
aws cloudwatch set-alarm-state --region ap-south-1 --alarm-name REPLACE_TARGET5XX_ALARM_NAME \
  --state-value ALARM --state-reason "Sprint alert delivery test"
```

**Pin the AMI and turn on protection through a reviewed change set:**

```bash
STACK=taskdesk-prod; AMI=REPLACE_RESOLVED_AMI_ID
args=()
for key in $(aws cloudformation describe-stacks --region ap-south-1 --stack-name $STACK \
             --query 'Stacks[0].Parameters[].ParameterKey' --output text); do
  case $key in
    PinnedAmiId) args+=("ParameterKey=$key,ParameterValue=$AMI") ;;
    TerminationProtection) args+=("ParameterKey=$key,ParameterValue=true") ;;
    *) args+=("ParameterKey=$key,UsePreviousValue=true") ;;
  esac
done
aws cloudformation create-change-set --region ap-south-1 --stack-name $STACK \
  --change-set-name pin-and-protect --use-previous-template --capabilities CAPABILITY_IAM \
  --parameters "${args[@]}"
aws cloudformation wait change-set-create-complete --region ap-south-1 --stack-name $STACK --change-set-name pin-and-protect
aws cloudformation describe-change-set --region ap-south-1 --stack-name $STACK --change-set-name pin-and-protect \
  --query 'Changes[].ResourceChange.[LogicalResourceId,Action,Replacement]' --output table
```

**Execute only if `AppInstance` shows `Replacement` = `False`.** If it shows `True` or `Conditional`, delete the change set and find out why. Then:

```bash
aws cloudformation execute-change-set --region ap-south-1 --stack-name $STACK --change-set-name pin-and-protect
```

From now on, every stack update uses a change set with the same check. Changing `DomainName` or the subnet CIDRs edits user data and restarts the instance.

- [ ] Alert test received by both; AMI pinned; termination and ALB deletion protection on.

## Step 10 — Launch checklist and handover (7:15–8:00)

### Minimum launch checklist

- [ ] **Access:** no business data without login; team/role boundaries hold on the API; no default/shared admin credentials; login/reset/offboarding process named. Local login without SSO is recorded as a temporary exception.
- [ ] **Normal work:** synthetic task cycle, attachment download, chat/SSE and desktop client on the company URL.
- [ ] **Uploads/updates:** type/size limits and ClamAV work; clients use the HTTPS update endpoint.
- [ ] **Host:** no public 22/3000/DB; data on `/srv/taskdesk`; secrets not on disk; startup guard refuses a missing DB.
- [ ] **Recovery:** cutover restore succeeded with matching keys; first production backup in S3; copies in the other India region; secret replica in sync; key break-glass copy confirmed by SEC.
- [ ] **Visibility:** both operators received the test alert; WAF/ALB/app logs readable; alarm states OK.
- [ ] **Rollout size:** current users only, unless the launch owner records a capacity decision. `IngressCidr` stays at the office IP until wider access is approved.
- [ ] Rehearsal copy removed: `sudo rm -rf /srv/taskdesk/rehearsal-data /srv/taskdesk/restore-in` (the `restore/` objects expire after 30 days).

### Handover record

| Record | Value / evidence | Owner / updated |
|---|---|---|
| Stack names (main / recovery / budget), account, regions, pinned AMI | Fill | Fill |
| VPC, subnets, ALB ARN/DNS, target group, WAF ARN, SG IDs, NAT ID | Fill (stack outputs) | Fill |
| Instance ID, data volume ID, filesystem UUID, data KMS key, recovery KMS key | Fill | Fill |
| Transfer bucket, ALB log bucket, recovery bucket, log groups | Fill | Fill |
| Release commit/SHA-256, runtime and SQLCipher library versions | Fill | Fill |
| Compose file, service, mounts, deployment.json environment | Fill | Fill |
| Company URL, DNS record, desktop client version, old clients remaining | Fill | Fill |
| Secret ARNs and replica region (no values) | Fill | Fill |
| Backup command, timer active, last backup time (IST), offsite copy time | Fill | Fill |
| Alert recipients and test time, alarm states | Fill | Fill |
| WAF mode, `IngressCidr`, health path | Fill | Fill |
| Laptop state (stopped, data kept until disposal decision) | Fill | Fill |

### Exceptions to open on day one

Record these in the exceptions register (After deployment folder) with owner and review date. They are known gaps, not failures:

| Exception | Closed by |
|---|---|
| WAF common/SQLi/IP-reputation rules in Count | Tuning, then `WafMode=Block` |
| No isolated restore drill or measured RTO/RPO yet | Restore drill |
| App backups copied offsite manually, once | S3 replication rule |
| Local login, no SSO/lifecycle automation | Identity work |
| 800-user capacity unproven; access limited to the office IP | Load test, then `IngressCidr` change |
| Old desktop clients still pointing at the laptop | Client transition |

The sprint ends here. Hand over to the **After deployment** folder: `Next steps - Reach full configuration` and `Maintenance and records`.

## References

- [CloudFormation EC2 instance](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-ec2-instance.html), [wait conditions](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/using-cfn-waitcondition.html), [change sets](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/using-cfn-updating-stacks-changesets.html)
- [Canonical Ubuntu AMI lookup](https://documentation.ubuntu.com/aws/aws-how-to/instances/find-ubuntu-images/), [Docker on Ubuntu](https://docs.docker.com/engine/install/ubuntu/)
- [ALB access logs](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/enable-access-logging.html), [WAF body inspection limit](https://docs.aws.amazon.com/waf/latest/developerguide/web-acl-setting-body-inspection-limit.html), [WAF managed rule groups](https://docs.aws.amazon.com/waf/latest/developerguide/aws-managed-rule-groups-list.html)
- [Data Lifecycle Manager cross-region copy](https://docs.aws.amazon.com/ebs/latest/userguide/snapshot-ami-policy.html), [Secrets Manager replication](https://docs.aws.amazon.com/secretsmanager/latest/userguide/replicate-secrets.html)
- [CloudWatch agent](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/install-CloudWatch-Agent-on-EC2-Instance.html), [Session Manager prerequisites](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-prerequisites.html)
