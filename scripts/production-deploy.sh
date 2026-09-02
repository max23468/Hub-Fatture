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
candidate_dir=${HUB_FATTURE_CANDIDATE_DIR:-$root/scripts}
shared_docker_lock=${SHARED_DOCKER_LOCK:-/run/lock/hub-fatture-sequent-docker.lock}
image="ghcr.io/max23468/hub-fatture@$digest"
cd "$root"
exec 9>./backup.lock
flock -n 9 || { echo "Un backup o deploy è già in corso" >&2; exit 1; }
exec 8>"$shared_docker_lock"
flock -n 8 || { echo "Una build o manutenzione Docker condivisa è già in corso" >&2; exit 1; }
if [ -f .deploy.env ] && [ ! -f data/operations/deploy-receipt.json ]; then
  residual_containers=$(docker compose -f compose.yaml --env-file .env --env-file .deploy.env ps --all -q) \
    || { echo "Stato del primo deploy non rilevabile" >&2; exit 1; }
  [ -z "$residual_containers" ] \
    || { echo "Container residui dal primo deploy fallito" >&2; exit 1; }
  rm -f .deploy.env compose.yaml Caddyfile data/operations/deploy-receipt.json.next
fi
[ -f compose.yaml.next ] || { echo "Compose candidato assente" >&2; exit 1; }
[ -f Caddyfile.next ] || { echo "Caddyfile candidato assente" >&2; exit 1; }
[ -d /opt/shared-caddy/sites ] && [ ! -L /opt/shared-caddy/sites ] \
  || { echo "Directory dei virtual host condivisi non conforme" >&2; exit 1; }
[ "$(stat -c '%U:%G:%a' /opt/shared-caddy/sites)" = root:root:755 ] \
  || { echo "Permessi dei virtual host condivisi non conformi" >&2; exit 1; }
shared_site_count=0
for shared_site in /opt/shared-caddy/sites/*.caddy; do
  [ -e "$shared_site" ] || continue
  [ -f "$shared_site" ] && [ ! -L "$shared_site" ] \
    && [ "$(stat -c '%U:%G:%a' "$shared_site")" = root:root:644 ] \
    || { echo "Virtual host condiviso non conforme" >&2; exit 1; }
  shared_site_count=$((shared_site_count + 1))
done
[ "$shared_site_count" -gt 0 ] \
  || { echo "Nessun virtual host condiviso qualificato" >&2; exit 1; }
docker network inspect sequent-proxy >/dev/null 2>&1 \
  || { echo "Rete del proxy pubblico condiviso assente" >&2; exit 1; }
[ -x "$candidate_dir/production-preflight.sh" ] \
  || { echo "Preflight candidato assente" >&2; exit 1; }
[ -x "$candidate_dir/production-readback.sh" ] \
  || { echo "Readback candidato assente" >&2; exit 1; }

submission_line_count=$(grep -c '^ARUBA_SUBMISSION_ENABLED=' .env || true)
[ "$submission_line_count" = "1" ] \
  || { echo "ARUBA_SUBMISSION_ENABLED deve comparire una sola volta" >&2; exit 1; }
expected_submission=$(sed -n 's/^ARUBA_SUBMISSION_ENABLED=//p' .env)
case "$expected_submission" in
  true | false) ;;
  *) echo "Valore ARUBA_SUBMISSION_ENABLED non valido" >&2; exit 1 ;;
esac

"$candidate_dir/production-preflight.sh" "$expected_submission"
docker pull "$image"
docker image inspect "$image" >/dev/null

previous=$(mktemp .deploy.env.previous.XXXXXX)
previous_compose=$(mktemp compose.yaml.previous.XXXXXX)
previous_caddy=$(mktemp Caddyfile.previous.XXXXXX)
trap 'rm -f "$previous" "$previous_compose" "$previous_caddy" .deploy.env.next compose.yaml.next Caddyfile.next' EXIT
previous_schema=
if [ -f .deploy.env ]; then
  previous_schema=$(docker compose -f compose.yaml --env-file .env --env-file .deploy.env exec -T \
    postgres psql -U hub_fatture -d hub_fatture -Atc "SELECT max(name) FROM schema_migrations")
  cp .deploy.env "$previous"
  install -m 600 .deploy.env data/operations/rollback.env.next
  mv data/operations/rollback.env.next data/operations/rollback.env
  cp compose.yaml "$previous_compose"
  cp Caddyfile "$previous_caddy"
  install -m 640 compose.yaml data/operations/rollback.compose.yaml.next
  mv data/operations/rollback.compose.yaml.next data/operations/rollback.compose.yaml
  install -m 640 Caddyfile data/operations/rollback.Caddyfile.next
  mv data/operations/rollback.Caddyfile.next data/operations/rollback.Caddyfile
else
  : >"$previous"
  : >"$previous_compose"
  : >"$previous_caddy"
fi

cat >.deploy.env.next <<EOF
APP_IMAGE=$image
APP_COMMIT_SHA=$commit
APP_IMAGE_DIGEST=$digest
APP_VERSION=$version
EOF
chmod 600 .deploy.env.next
docker compose -f compose.yaml.next --env-file .env --env-file .deploy.env.next config --quiet
mv compose.yaml.next compose.yaml
mv Caddyfile.next Caddyfile
mv .deploy.env.next .deploy.env

rollback() {
  if [ -s "$previous" ] && [ -s "$previous_compose" ] && [ -s "$previous_caddy" ]; then
    current_schema=$(docker compose -f compose.yaml --env-file .env --env-file .deploy.env exec -T \
      postgres psql -U hub_fatture -d hub_fatture -Atc \
      "SELECT max(name) FROM schema_migrations" 2>/dev/null || true)
    if [ -z "$current_schema" ] || [ "$current_schema" != "$previous_schema" ]; then
      echo "Schema avanzato o non rilevabile; rollback automatico vietato, applicare un forward-fix" >&2
      return 1
    fi
    cp "$previous" .deploy.env
    cp "$previous_compose" compose.yaml
    cp "$previous_caddy" Caddyfile
    docker compose -f compose.yaml --env-file .env --env-file .deploy.env up -d --wait --force-recreate
    ./scripts/production-readback.sh "$expected_submission" >/dev/null
  else
    if ! docker compose -f compose.yaml --env-file .env --env-file .deploy.env down; then
      echo "Arresto del primo deploy fallito" >&2
      return 1
    fi
    rm -f .deploy.env compose.yaml Caddyfile
  fi
}

if ! docker compose -f compose.yaml --env-file .env --env-file .deploy.env up -d --wait --force-recreate \
  || ! "$candidate_dir/production-readback.sh" "$expected_submission" \
    >data/operations/deploy-receipt.json.next; then
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
