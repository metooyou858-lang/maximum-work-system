#!/usr/bin/env bash
# Только диагностика: не перезапускает службы и не меняет данные.
set -uo pipefail
export LC_ALL=C
failures=0
warnings=0
ok() { printf 'OK   %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1"; failures=$((failures + 1)); }
warn() { printf 'WARN %s\n' "$1"; warnings=$((warnings + 1)); }
if [ "$(id -u)" -ne 0 ]; then
  printf 'Run through sudo -n bash.\n'
  exit 2
fi
printf 'MAXIMUM test VPS — %s\n' "$(date -u +%FT%TZ)"
printf 'Kernel: %s; uptime: %s\n' "$(uname -r)" "$(uptime -p)"
for unit in ssh ufw fail2ban postgresql; do
  if systemctl is-active --quiet "$unit"; then ok "$unit active"; else fail "$unit inactive"; fi
done
for unit in ufw fail2ban apt-daily-upgrade.timer maximum-test-backup.timer; do
  if systemctl is-enabled --quiet "$unit"; then ok "$unit enabled"; else fail "$unit not enabled"; fi
done
if systemctl is-active --quiet maximum-test-backup.timer; then ok 'backup timer active'; else fail 'backup timer inactive'; fi
failed_units=$(systemctl --failed --no-legend --plain)
if [ -z "$failed_units" ]; then ok 'no failed units'; else fail 'failed systemd units'; printf '%s\n' "$failed_units"; fi
firewall=$(ufw status verbose)
if grep -q '^Status: active$' <<< "$firewall" && grep -q 'Default: deny (incoming)' <<< "$firewall"; then
  ok 'firewall active, incoming denied by default'
else fail 'firewall disabled or incoming policy changed'; fi
printf '%s\n' "$firewall"
ssh_config=$(/usr/sbin/sshd -T)
for setting in 'permitrootlogin no' 'passwordauthentication no' 'kbdinteractiveauthentication no' 'authenticationmethods publickey' 'allowusers maximum-admin'; do
  if grep -qx "$setting" <<< "$ssh_config"; then ok "SSH $setting"; else fail "SSH expected: $setting"; fi
done
db_result=$(runuser -u maximum -- psql -X -v ON_ERROR_STOP=1 -d maximum_test -tAc 'SELECT 1' 2>/dev/null)
if [ "$db_result" = 1 ]; then ok 'database query as application user'; else fail 'database query failed'; fi
db_listen=$(runuser -u postgres -- psql -X -tAc 'SHOW listen_addresses' 2>/dev/null)
if [ "$?" -eq 0 ] && [ -z "$db_listen" ]; then ok 'database TCP disabled'; else fail 'database TCP configuration changed or unavailable'; fi
printf 'Listening TCP ports (review any unexpected public listener):\n'
ss -lnt
latest=$(find /var/backups/maximum-test -maxdepth 1 -type f -name 'maximum_test_*.dump' -printf '%T@ %p\n' 2>/dev/null | sort -nr | head -n 1 | cut -d ' ' -f 2-)
if [ -n "$latest" ]; then
  age=$(( $(date +%s) - $(stat -c %Y "$latest") ))
  if [ "$age" -ge 0 ] && [ "$age" -le 93600 ]; then ok "backup age $((age / 3600)) hours"; else fail 'backup older than 26 hours or clock mismatch'; fi
  if pg_restore --list "$latest" >/dev/null 2>&1; then ok 'backup archive readable (not a full restore test)'; else fail 'backup archive unreadable'; fi
else fail 'no local database backup'; fi
backup_result=$(systemctl show maximum-test-backup.service -p Result --value)
if [ "$backup_result" = success ]; then ok 'last backup service result success'; else fail "backup service result: $backup_result"; fi
disk_used=$(df -P / | awk 'NR==2 {gsub(/%/, "", $5); print $5}')
if [ "$disk_used" -ge 90 ]; then fail "root disk used ${disk_used}%"; elif [ "$disk_used" -ge 80 ]; then warn "root disk used ${disk_used}%"; else ok "root disk used ${disk_used}%"; fi
available_mb=$(awk '/MemAvailable:/ {print int($2/1024)}' /proc/meminfo)
if [ "$available_mb" -lt 200 ]; then warn "available RAM ${available_mb} MiB"; else ok "available RAM ${available_mb} MiB"; fi
if swapon --noheadings --show | grep -q .; then ok 'swap active'; else warn 'no active swap'; fi
if [ -f /var/run/reboot-required ]; then warn 'reboot required; schedule before restarting'; else ok 'no reboot requested'; fi
audit=$(dpkg --audit)
if [ -z "$audit" ]; then ok 'package database consistent'; else fail 'dpkg audit findings'; printf '%s\n' "$audit"; fi
printf '\nRESULT: %s failures, %s warnings\n' "$failures" "$warnings"
printf 'Scope: infrastructure only; application not deployed; backups are on this VPS.\n'
if [ "$failures" -gt 0 ]; then exit 2; fi
if [ "$warnings" -gt 0 ]; then exit 1; fi
