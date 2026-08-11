#!/bin/sh
set -eu

reason=${1:-scheduled}
root=${HUB_FATTURE_ROOT:-/opt/hub-fatture}
cd "$root"
# shellcheck disable=SC1091
. ./scripts/read-env.sh
notifications_topic=$(env_value .env OCI_NOTIFICATIONS_TOPIC_OCID)

notify_failure() {
  status=${1:-$?}
  if [ "$status" -ne 0 ] && [ -n "$notifications_topic" ]; then
    oci ons message publish --auth instance_principal \
      --topic-id "$notifications_topic" \
      --title "Hub Fatture: backup non riuscito" \
      --body "Il backup Production non è stato completato. Controllare il timer sulla VPS." \
      >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap notify_failure EXIT HUP INT TERM

exec 9>./backup.lock
flock -n 9 || { echo "Un backup o deploy è già in corso" >&2; exit 1; }

for name in AGE_RECIPIENT OCI_BACKUP_BUCKET OCI_NAMESPACE; do
  value=$(env_value .env "$name")
  [ -n "$value" ] || { echo "Configurazione backup incompleta: $name" >&2; exit 1; }
done
age_recipient=$(env_value .env AGE_RECIPIENT)
backup_bucket=$(env_value .env OCI_BACKUP_BUCKET)
oci_namespace=$(env_value .env OCI_NAMESPACE)
[ -d /dev/shm ] || { echo "tmpfs /dev/shm non disponibile" >&2; exit 1; }

tmp=$(mktemp -d /dev/shm/hub-fatture-backup.XXXXXX)
umask 077
writers_paused=0

resume_writers() {
  [ "$writers_paused" -eq 1 ] || return 0
  docker compose -f compose.yaml --env-file .env --env-file .deploy.env \
    unpause app-web app-worker >/dev/null
  writers_paused=0
}

cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  resume_writers || status=1
  rm -rf "$tmp"
  notify_failure "$status"
}
trap cleanup EXIT HUP INT TERM

docker compose -f compose.yaml --env-file .env --env-file .deploy.env \
  pause app-web app-worker >/dev/null
writers_paused=1
docker compose -f compose.yaml --env-file .env --env-file .deploy.env \
  run --rm --no-deps app-web node -e \
  "import('./build-server/db/documents.server.js').then(m => m.reconcileDocumentStorage())" \
  >/dev/null

docker compose -f compose.yaml --env-file .env --env-file .deploy.env exec -T postgres \
  pg_dump --format=custom --no-owner --no-privileges -U hub_fatture -d hub_fatture \
  >"$tmp/database.dump"

schema=$(docker compose -f compose.yaml --env-file .env --env-file .deploy.env exec -T postgres \
  psql -U hub_fatture -d hub_fatture -Atc "SELECT max(name) FROM schema_migrations")
set -a
# shellcheck disable=SC1091
. ./.deploy.env
set +a
created_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
jq -n --arg createdAt "$created_at" --arg commit "$APP_COMMIT_SHA" \
  --arg imageDigest "$APP_IMAGE_DIGEST" --arg reason "$reason" --arg schema "$schema" \
  '{createdAt:$createdAt,commit:$commit,imageDigest:$imageDigest,schema:$schema,reason:$reason}' \
  >"$tmp/manifest.json"

archive="$tmp/hub-fatture.tar.age"
tar -C "$tmp" -cf - database.dump manifest.json \
  -C "$root" data/documents data/operations/deploy-receipt.json \
  | age --recipient "$age_recipient" --output "$archive"
resume_writers
sha=$(sha256sum "$archive" | awk '{print $1}')
size=$(stat -c %s "$archive")
object="hub-fatture/archive/$(date -u +%Y/%m/%d)/$(date -u +%Y%m%dT%H%M%SZ)-$APP_COMMIT_SHA.tar.age"
current="hub-fatture/current/latest.tar.age"

oci os object put --auth instance_principal --namespace "$oci_namespace" \
  --bucket-name "$backup_bucket" --name "$object" --file "$archive" --force \
  --metadata "{\"sha256\":\"$sha\"}" >/dev/null
head=$(oci os object head --auth instance_principal --namespace "$oci_namespace" \
  --bucket-name "$backup_bucket" --name "$object")
[ "$(printf '%s' "$head" | jq -r '."content-length" // empty')" = "$size" ] \
  || { echo "Dimensione backup riletta non valida" >&2; exit 1; }
[ "$(printf '%s' "$head" | jq -r '."opc-meta-sha256" // empty')" = "$sha" ] \
  || { echo "Checksum backup riletto non valido" >&2; exit 1; }
oci os object put --auth instance_principal --namespace "$oci_namespace" \
  --bucket-name "$backup_bucket" --name "$current" --file "$archive" --force \
  --metadata "{\"sha256\":\"$sha\",\"source\":\"$object\"}" >/dev/null
current_head=$(oci os object head --auth instance_principal --namespace "$oci_namespace" \
  --bucket-name "$backup_bucket" --name "$current")
[ "$(printf '%s' "$current_head" | jq -r '."opc-meta-sha256" // empty')" = "$sha" ] \
  || { echo "Copia protetta corrente non verificata" >&2; exit 1; }

jq -n --arg completedAt "$created_at" --arg objectName "$object" --arg sha256 "$sha" \
  --argjson sizeBytes "$size" \
  '{status:"ok",completedAt:$completedAt,objectName:$objectName,sha256:$sha256,sizeBytes:$sizeBytes}' \
  >data/operations/backup-receipt.json.next
chmod 640 data/operations/backup-receipt.json.next
chown 10001:10001 data/operations/backup-receipt.json.next
mv data/operations/backup-receipt.json.next data/operations/backup-receipt.json
trap - EXIT HUP INT TERM
rm -rf "$tmp"
echo "Backup cifrato verificato: $object"
