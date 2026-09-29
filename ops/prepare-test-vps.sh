#!/usr/bin/env bash
set -euo pipefail
test "$(id -u)" -eq 0
export DEBIAN_FRONTEND=noninteractive
apt-get install -y postgresql postgresql-client fail2ban unattended-upgrades
ufw allow 22/tcp
systemctl unmask ufw
systemctl enable ufw
ufw --force enable
systemctl start ufw

id maximum-admin >/dev/null 2>&1 || useradd --create-home --shell /bin/bash maximum-admin
install -d -m 700 -o maximum-admin -g maximum-admin /home/maximum-admin/.ssh
grep ' maximum-vps$' /root/.ssh/authorized_keys > /home/maximum-admin/.ssh/authorized_keys
chown maximum-admin:maximum-admin /home/maximum-admin/.ssh/authorized_keys
chmod 600 /home/maximum-admin/.ssh/authorized_keys
printf 'maximum-admin ALL=(ALL:ALL) NOPASSWD: ALL\n' > /etc/sudoers.d/maximum-admin
chmod 440 /etc/sudoers.d/maximum-admin
visudo -cf /etc/sudoers.d/maximum-admin

id maximum >/dev/null 2>&1 || useradd --system --home-dir /var/lib/maximum --shell /usr/sbin/nologin maximum
install -d -m 750 -o maximum-admin -g maximum /srv/maximum
install -d -m 700 -o maximum -g maximum /var/lib/maximum
install -d -m 750 -o root -g maximum /etc/maximum
printf 'APP_ENV=test\nALLOW_REAL_PERSONAL_DATA=false\n' > /etc/maximum/environment
chmod 640 /etc/maximum/environment
chown root:maximum /etc/maximum/environment

if ! runuser -u postgres -- psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='maximum'" | grep -qx 1; then
  runuser -u postgres -- createuser --no-superuser --no-createdb --no-createrole maximum
fi
if ! runuser -u postgres -- psql -tAc "SELECT 1 FROM pg_database WHERE datname='maximum_test'" | grep -qx 1; then
  runuser -u postgres -- createdb --owner=maximum maximum_test
fi
runuser -u postgres -- psql -v ON_ERROR_STOP=1 -c "ALTER SYSTEM SET listen_addresses = '';"
systemctl restart postgresql

cat > /etc/fail2ban/jail.d/maximum-sshd.local <<'EOF'
[sshd]
enabled = true
backend = systemd
port = 22
maxretry = 5
findtime = 10m
bantime = 1h
EOF
systemctl enable --now fail2ban
systemctl restart fail2ban

cat > /etc/apt/apt.conf.d/52maximum-unattended <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
Unattended-Upgrade::Automatic-Reboot "false";
EOF
install -d -m 755 /etc/systemd/journald.conf.d
cat > /etc/systemd/journald.conf.d/maximum.conf <<'EOF'
[Journal]
Storage=persistent
SystemMaxUse=200M
MaxRetentionSec=30day
EOF
systemctl restart systemd-journald

install -d -m 700 -o root -g root /var/backups/maximum-test
cat > /usr/local/sbin/maximum-test-backup <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
umask 077
exec 9>/run/maximum-test-backup.lock
flock -n 9 || exit 0
backup_dir=/var/backups/maximum-test
target="$backup_dir/maximum_test_$(date -u +%Y%m%dT%H%M%S%NZ).dump"
trap 'rm -f -- "$target.partial"' EXIT
runuser -u postgres -- pg_dump --format=custom maximum_test > "$target.partial"
pg_restore --list "$target.partial" >/dev/null
mv -- "$target.partial" "$target"
find "$backup_dir" -maxdepth 1 -type f -name 'maximum_test_*.dump' -mmin +10080 -delete
printf 'Test database backup completed: %s\n' "$target"
EOF
chmod 750 /usr/local/sbin/maximum-test-backup
cat > /etc/systemd/system/maximum-test-backup.service <<'EOF'
[Unit]
Description=Local backup of synthetic MAXIMUM test data
After=postgresql.service
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/maximum-test-backup
UMask=0077
PrivateTmp=true
ProtectHome=true
EOF
cat > /etc/systemd/system/maximum-test-backup.timer <<'EOF'
[Unit]
Description=Daily local backup of synthetic MAXIMUM test data
[Timer]
OnCalendar=*-*-* 03:15:00 UTC
RandomizedDelaySec=10m
Persistent=true
[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now maximum-test-backup.timer
systemctl start maximum-test-backup.service
printf 'TEST_VPS_PREPARED\n'
