#!/bin/sh
set -eu

digest=${1:-}
commit=${2:-}
version=${3:-}
printf '%s' "$digest" | grep -Eq '^sha256:[0-9a-f]{64}$' \
  || { echo "Digest non valido" >&2; exit 2; }
printf '%s' "$commit" | grep -Eq '^[0-9a-f]{40}$' || { echo "Commit non valido" >&2; exit 2; }
printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.-]+)?$' \
  || { echo "Versione non valida" >&2; exit 2; }

root=${HUB_FATTURE_ROOT:-/opt/hub-fatture}
image="ghcr.io/max23468/hub-fatture@$digest"
cd "$root"
exec 9>./deploy.lock
flock -n 9 || { echo "Un altro deploy è in corso" >&2; exit 1; }

./scripts/production-preflight.sh
docker pull "$image"
docker image inspect "$image" >/dev/null

previous=$(mktemp .deploy.env.previous.XXXXXX)
trap 'rm -f "$previous" .deploy.env.next' EXIT
previous_schema=
if [ -f .deploy.env ]; then
  previous_schema=$(docker compose -f compose.yaml --env-file .env --env-file .deploy.env exec -T \
    postgres psql -U hub_fatture -d hub_fatture -Atc "SELECT max(name) FROM schema_migrations")
  cp .deploy.env "$previous"
  install -m 600 .deploy.env data/operations/rollback.env.next
  mv data/operations/rollback.env.next data/operations/rollback.env
else
  : >"$previous"
fi

cat >.deploy.env.next <<EOF
APP_IMAGE=$image
APP_COMMIT_SHA=$commit
APP_IMAGE_DIGEST=$digest
APP_VERSION=$version
EOF
chmod 600 .deploy.env.next
mv .deploy.env.next .deploy.env

rollback() {
  if [ -s "$previous" ]; then
    current_schema=$(docker compose -f compose.yaml --env-file .env --env-file .deploy.env exec -T \
      postgres psql -U hub_fatture -d hub_fatture -Atc \
      "SELECT max(name) FROM schema_migrations" 2>/dev/null || true)
    if [ -z "$current_schema" ] || [ "$current_schema" != "$previous_schema" ]; then
      echo "Schema avanzato o non rilevabile; rollback automatico vietato, applicare un forward-fix" >&2
      return 1
    fi
    cp "$previous" .deploy.env
    docker compose -f compose.yaml --env-file .env --env-file .deploy.env up -d --wait
    ./scripts/production-readback.sh >/dev/null
  else
    docker compose -f compose.yaml --env-file .env --env-file .deploy.env down
  fi
}

if ! docker compose -f compose.yaml --env-file .env --env-file .deploy.env config --quiet \
  || ! docker compose -f compose.yaml --env-file .env --env-file .deploy.env up -d --wait \
  || ! ./scripts/production-readback.sh >data/operations/deploy-receipt.json.next; then
  if rollback; then
    echo "Deploy non riuscito; rollback applicativo verificato" >&2
  else
    echo "Deploy non riuscito; candidato conservato per forward-fix" >&2
  fi
  exit 1
fi
chown 10001:10001 data/operations/deploy-receipt.json.next
chmod 640 data/operations/deploy-receipt.json.next
mv data/operations/deploy-receipt.json.next data/operations/deploy-receipt.json
echo "Deploy Production verificato: $commit $digest"
