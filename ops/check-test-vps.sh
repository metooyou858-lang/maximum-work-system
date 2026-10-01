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
for unit in ssh ufw fail2ban maximum maximum-work caddy; do
  if systemctl is-active --quiet "$unit"; then ok "$unit active"; else fail "$unit inactive"; fi
done
for unit in ufw fail2ban maximum maximum-work caddy maximum-backup.timer; do
  if systemctl is-enabled --quiet "$unit"; then ok "$unit enabled"; else fail "$unit not enabled"; fi
done
if systemctl is-active --quiet maximum-backup.timer; then ok 'SQLite backup timer active'; else fail 'SQLite backup timer inactive'; fi
failed_units=$(systemctl --failed --no-legend --plain)
if [ -z "$failed_units" ]; then ok 'no failed units'; else fail 'failed systemd units'; printf '%s\n' "$failed_units"; fi
firewall=$(ufw status verbose)
if grep -q '^Status: active$' <<< "$firewall" && grep -q 'Default: deny (incoming)' <<< "$firewall"; then
  ok 'firewall active, incoming denied by default'
else fail 'firewall disabled or incoming policy changed'; fi
for port in '22/tcp' '80/tcp' '443/tcp'; do
  if grep -q "^$port" <<< "$firewall"; then ok "firewall allows $port"; else fail "firewall missing $port"; fi
done
printf '%s\n' "$firewall"
ssh_config=$(/usr/sbin/sshd -T)
for setting in 'permitrootlogin no' 'passwordauthentication no' 'kbdinteractiveauthentication no' 'authenticationmethods publickey' 'allowusers maximum-admin'; do
  if grep -qx "$setting" <<< "$ssh_config"; then ok "SSH $setting"; else fail "SSH expected: $setting"; fi
done
if curl --fail --silent --show-error http://127.0.0.1:4173/api/health | grep -q '"ok":true'; then ok 'application health endpoint'; else fail 'application health endpoint'; fi
if curl --fail --silent --show-error --connect-timeout 10 https://89-125-214-188.sslip.io/api/health | grep -q '"ok":true'; then ok 'public HTTPS proxy'; else fail 'public HTTPS proxy'; fi
if curl --fail --silent --show-error http://127.0.0.1:4174/api/health | grep -q '"ok":true'; then ok 'work cabinet health endpoint'; else fail 'work cabinet health endpoint'; fi
if curl --fail --silent --show-error --connect-timeout 10 https://89-125-214-188.sslip.io/manager/api/health | grep -q '"ok":true'; then ok 'work cabinet public HTTPS path'; else fail 'work cabinet public HTTPS path'; fi
if [ -r /etc/maximum/environment ] && grep -q '^YANDEX_MAPS_API_KEY=[0-9a-f-]\{36\}$' /etc/maximum/environment; then ok 'Yandex Maps key present without printing it'; else fail 'Yandex Maps key missing or malformed'; fi
latest=$(find /var/backups/maximum -maxdepth 1 -type f -name 'demo_*.sqlite' -printf '%T@ %p\n' 2>/dev/null | sort -nr | head -n 1 | cut -d ' ' -f 2-)
if [ -n "$latest" ]; then
  age=$(( $(date +%s) - $(stat -c %Y "$latest") ))
  if [ "$age" -ge 0 ] && [ "$age" -le 93600 ]; then ok "SQLite backup age $((age / 3600)) hours"; else fail 'SQLite backup older than 26 hours or clock mismatch'; fi
  if sqlite3 "$latest" 'PRAGMA integrity_check' | grep -qx ok; then ok 'SQLite backup integrity'; else fail 'SQLite backup integrity'; fi
else fail 'no SQLite backup'; fi
backup_result=$(systemctl show maximum-backup.service -p Result --value)
if [ "$backup_result" = success ]; then ok 'last SQLite backup result success'; else fail "SQLite backup result: $backup_result"; fi
printf 'Listening TCP ports (review any unexpected public listener):\n'
ss -lnt
disk_used=$(df -P / | awk 'NR==2 {gsub(/%/, "", $5); print $5}')
if [ "$disk_used" -ge 90 ]; then fail "root disk used ${disk_used}%"; elif [ "$disk_used" -ge 80 ]; then warn "root disk used ${disk_used}%"; else ok "root disk used ${disk_used}%"; fi
available_mb=$(awk '/MemAvailable:/ {print int($2/1024)}' /proc/meminfo)
if [ "$available_mb" -lt 200 ]; then warn "available RAM ${available_mb} MiB"; else ok "available RAM ${available_mb} MiB"; fi
if swapon --noheadings --show | grep -q .; then ok 'swap active'; else warn 'no active swap'; fi
if [ -f /var/run/reboot-required ]; then warn 'reboot required; schedule before restarting'; else ok 'no reboot requested'; fi
audit=$(dpkg --audit)
if [ -z "$audit" ]; then ok 'package database consistent'; else fail 'dpkg audit findings'; printf '%s\n' "$audit"; fi
printf '\nRESULT: %s failures, %s warnings\n' "$failures" "$warnings"
printf 'Scope: synthetic test application, HTTPS proxy and local SQLite backup.\n'
if [ "$failures" -gt 0 ]; then exit 2; fi
if [ "$warnings" -gt 0 ]; then exit 1; fi
