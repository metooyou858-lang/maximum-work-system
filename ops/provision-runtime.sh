#!/usr/bin/env bash
set -euo pipefail

test "$(id -u)" -eq 0
export DEBIAN_FRONTEND=noninteractive

node_version='24.21.0'
node_archive="node-v${node_version}-linux-x64.tar.xz"
node_url="https://nodejs.org/dist/v${node_version}/${node_archive}"
node_checksums_url="https://nodejs.org/dist/v${node_version}/SHASUMS256.txt"

apt-get update
apt-get install -y --no-install-recommends ca-certificates caddy curl sqlite3 unattended-upgrades

install -d -m 755 /opt/maximum-downloads
curl --fail --show-error --silent --location "$node_url" -o "/opt/maximum-downloads/${node_archive}"
curl --fail --show-error --silent --location "$node_checksums_url" -o /opt/maximum-downloads/SHASUMS256.txt
(
  cd /opt/maximum-downloads
  grep "  ${node_archive}$" SHASUMS256.txt | sha256sum --check --status -
)
rm -rf "/opt/node-v${node_version}-linux-x64"
tar -xJf "/opt/maximum-downloads/${node_archive}" -C /opt
ln -sfn "/opt/node-v${node_version}-linux-x64/bin/node" /usr/local/bin/node
ln -sfn "/opt/node-v${node_version}-linux-x64/bin/npm" /usr/local/bin/npm
ln -sfn "/opt/node-v${node_version}-linux-x64/bin/npx" /usr/local/bin/npx
ln -sfn "/opt/node-v${node_version}-linux-x64/bin/corepack" /usr/local/bin/corepack
rm -f "/opt/maximum-downloads/${node_archive}" /opt/maximum-downloads/SHASUMS256.txt

id maximum >/dev/null 2>&1 || useradd --system --home-dir /var/lib/maximum --create-home --shell /usr/sbin/nologin maximum
install -d -m 750 -o maximum -g maximum /srv/maximum /var/lib/maximum
install -d -m 750 -o root -g maximum /etc/maximum

systemctl disable --now caddy
systemctl enable unattended-upgrades

node --version
npm --version
caddy version
printf 'RUNTIME_PROVISIONED\n'
