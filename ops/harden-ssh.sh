#!/usr/bin/env bash
set -euo pipefail
test "$(id -u)" -eq 0
test -s /home/maximum-admin/.ssh/authorized_keys
test ! -e /etc/ssh/sshd_config.d/00-maximum.conf

# Запускать только после проверки входа maximum-admin в отдельном соединении.
systemd-run --unit=maximum-ssh-rollback --on-active=5m /bin/sh -c 'rm -f /etc/ssh/sshd_config.d/00-maximum.conf; systemctl reload ssh'
cat > /etc/ssh/sshd_config.d/00-maximum.conf <<'EOF'
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
AuthenticationMethods publickey
AllowUsers maximum-admin
X11Forwarding no
AllowAgentForwarding no
AllowTcpForwarding local
GatewayPorts no
PermitTunnel no
MaxAuthTries 3
LoginGraceTime 30
EOF
/usr/sbin/sshd -t
systemctl reload ssh
printf 'Reconnect as maximum-admin; after success stop maximum-ssh-rollback.timer within 5 minutes.\n'
