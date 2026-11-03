#!/bin/bash
# Installs the TaskDesk host files from this directory onto the EC2 host.
# Safe to re-run. Never overwrites an existing deployment.json or backup.conf. Enables nothing.
set -euo pipefail
test "$(id -u)" -eq 0 || { echo "run with sudo" >&2; exit 1; }
src=$(cd "$(dirname "$0")" && pwd)

install -o root -g root -m 0700 "$src/taskdesk-launch" "$src/taskdesk-backup-verified" /usr/local/sbin/
install -o root -g root -m 0644 "$src/taskdesk.service" "$src/taskdesk-backup.service" "$src/taskdesk-backup.timer" /etc/systemd/system/
install -o root -g root -m 0644 "$src/taskdesk.logrotate" /etc/logrotate.d/taskdesk
install -d -m 0750 /var/log/taskdesk /etc/taskdesk
for log in service.log backup.log; do
  test -e "/var/log/taskdesk/$log" || install -m 0640 /dev/null "/var/log/taskdesk/$log"
done
for conf in deployment.json backup.conf; do
  test -e "/etc/taskdesk/$conf" || install -o root -g root -m 0600 "$src/$conf.example" "/etc/taskdesk/$conf"
done
systemctl daemon-reload
echo "Installed. Edit /etc/taskdesk/deployment.json and /etc/taskdesk/backup.conf, replace REPLACE_ACTUAL_APP_CONTAINER in /etc/systemd/system/taskdesk.service, then follow the workbook."
