#!/bin/sh
set -eu

root=${HUB_FATTURE_ROOT:-/opt/hub-fatture}
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
expected_hostname=${EXPECTED_HOSTNAME:-fatture-hub-vm}
expected_region=${OCI_REGION:-eu-milan-1}
# shellcheck disable=SC1091
. "$script_dir/read-env.sh"

fail() {
  echo "Preflight Production bloccato: $1" >&2
  exit 1
}

[ "$(uname -m)" = "aarch64" ] || fail "la VPS non è ARM64"
[ "$(hostname -s)" = "$expected_hostname" ] || fail "hostname VPS inatteso"
[ -d "$root" ] || fail "directory applicativa assente"
[ -f "$root/.env" ] || fail "configurazione Production assente"
[ "$(stat -c %a "$root/.env")" = "600" ] || fail "permessi .env diversi da 600"

for command in age bash curl docker flock jq oci; do
  command -v "$command" >/dev/null 2>&1 || fail "comando $command assente"
done
docker compose version >/dev/null 2>&1 || fail "Docker Compose non disponibile"

metadata=$(curl --fail --silent --show-error --max-time 3 \
  -H "Authorization: Bearer Oracle" http://169.254.169.254/opc/v2/instance/)
[ "$(printf '%s' "$metadata" | jq -r .displayName)" = "fatture-hub-vm" ] \
  || fail "istanza OCI inattesa"
[ "$(printf '%s' "$metadata" | jq -r .region)" = "$expected_region" ] \
  || fail "regione OCI inattesa"

for name in ADMIN_BOOTSTRAP_TOKEN AGE_RECIPIENT CADDY_ACME_EMAIL CREDENTIALS_ENCRYPTION_KEY \
  ARUBA_ACCOUNT_IDENTITY EXPECTED_PUBLIC_IP OCI_BACKUP_BUCKET OCI_NAMESPACE OCI_NOTIFICATIONS_TOPIC_OCID \
  POSTGRES_PASSWORD SMTP_FROM SMTP_PASSWORD SMTP_USERNAME; do
  value=$(env_value "$root/.env" "$name")
  [ -n "$value" ] || fail "variabile $name assente"
done
expected_public_ip=$(env_value "$root/.env" EXPECTED_PUBLIC_IP)
notifications_topic=$(env_value "$root/.env" OCI_NOTIFICATIONS_TOPIC_OCID)
smtp_from=$(env_value "$root/.env" SMTP_FROM)
printf '%s' "$expected_public_ip" | grep -Eq '^([0-9]{1,3}[.]){3}[0-9]{1,3}$' \
  || fail "IP pubblico atteso non valido"
dns_ip=$(getent ahostsv4 fatture.opik.net | awk 'NR == 1 { print $1 }')
[ "$dns_ip" = "$expected_public_ip" ] || fail "Dynu non punta all’IP OCI atteso"
printf '%s' "$notifications_topic" | grep -Eq '^ocid1\.onstopic\.oc1\.' \
  || fail "Notifications Topic OCI non valido"
[ "$(env_value "$root/.env" ARUBA_SUBMISSION_ENABLED)" = "false" ] \
  || fail "kill switch Aruba non disabilitato"
[ "$(env_value "$root/.env" ARUBA_CANARY_ENABLED)" = "false" ] \
  || fail "gate opzionale del canary reale non disabilitato"
[ "$(env_value "$root/.env" ARUBA_ACCOUNT_IDENTITY)" != "synthetic-aruba-account" ] \
  || fail "identità Aruba non qualificata"
case "$(printf '%s' "$smtp_from" | tr '[:upper:]' '[:lower:]')" in
  *@numisleo.it) ;;
  *) fail "mittente SMTP inatteso" ;;
esac

echo "Preflight Production superato."
