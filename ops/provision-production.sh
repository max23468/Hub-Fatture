#!/bin/sh
set -eu

[ "$(id -u)" -eq 0 ] || { echo "Eseguire con sudo" >&2; exit 1; }
[ "$(uname -m)" = "aarch64" ] || { echo "Target non ARM64" >&2; exit 1; }
[ "$(hostname -s)" = "fatture-hub-vm" ] || { echo "Target VPS inatteso" >&2; exit 1; }

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install --yes --no-install-recommends \
  age ca-certificates curl docker.io docker-compose-v2 jq python3-venv ufw unattended-upgrades
systemctl enable --now docker
systemctl enable --now unattended-upgrades
if snap list oracle-cloud-agent >/dev/null 2>&1; then
  snap start --enable oracle-cloud-agent >/dev/null
else
  systemctl enable --now oracle-cloud-agent
fi

if ! command -v oci >/dev/null 2>&1; then
  python3 -m venv /opt/oci-cli
  /opt/oci-cli/bin/pip install --disable-pip-version-check oci-cli==3.90.1
  ln -s /opt/oci-cli/bin/oci /usr/local/bin/oci
fi

getent group hub-fatture >/dev/null 2>&1 || groupadd --gid 10001 hub-fatture
id hub-fatture >/dev/null 2>&1 \
  || useradd --uid 10001 --gid hub-fatture --no-create-home --shell /usr/sbin/nologin hub-fatture
install -d -m 750 -o root -g root /opt/hub-fatture /opt/hub-fatture/scripts
install -d -m 750 -o 10001 -g 10001 \
  /opt/hub-fatture/data/documents /opt/hub-fatture/data/operations
install -d -m 750 -o 999 -g 999 /opt/hub-fatture/data/postgres
install -d -m 750 -o root -g root \
  /opt/hub-fatture/data/caddy/data /opt/hub-fatture/data/caddy/config \
  /opt/hub-fatture/data/logs/caddy

install -m 644 ops/sshd-hub-fatture.conf /etc/ssh/sshd_config.d/60-hub-fatture.conf
sshd -t
systemctl reload ssh

ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw --force enable

echo "Provisioning base completato; configurare .env prima del deploy."
