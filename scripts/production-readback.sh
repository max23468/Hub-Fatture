#!/bin/sh
set -eu

root=${HUB_FATTURE_ROOT:-/opt/hub-fatture}
cd "$root"

[ -f .deploy.env ] || { echo "Ricevuta deploy assente" >&2; exit 1; }
set -a
# shellcheck disable=SC1091
. ./.deploy.env
set +a

expected_image="ghcr.io/max23468/hub-fatture@${APP_IMAGE_DIGEST}"
for service in app-web app-worker; do
  container=$(docker compose -f compose.yaml --env-file .env --env-file .deploy.env ps -q "$service")
  [ -n "$container" ] || { echo "Container $service assente" >&2; exit 1; }
  actual=$(docker inspect --format '{{.Config.Image}}' "$container")
  [ "$actual" = "$expected_image" ] || { echo "Digest $service inatteso" >&2; exit 1; }
done

curl --fail --silent --show-error --max-time 10 --retry 35 --retry-delay 5 \
  --retry-max-time 180 --retry-all-errors https://fatture.opik.net/health \
  | jq -e '.status == "ok"' >/dev/null

schema=$(docker compose -f compose.yaml --env-file .env --env-file .deploy.env exec -T postgres \
  psql -U hub_fatture -d hub_fatture -Atc "SELECT max(name) FROM schema_migrations")
[ -n "$schema" ] || { echo "Schema non rilevato" >&2; exit 1; }

kill_switch=$(docker compose -f compose.yaml --env-file .env --env-file .deploy.env exec -T app-web \
  sh -c 'printf %s "$ARUBA_SUBMISSION_ENABLED"')
[ "$kill_switch" = "false" ] || { echo "Kill switch Aruba inatteso" >&2; exit 1; }
canary_enabled=$(docker compose -f compose.yaml --env-file .env --env-file .deploy.env exec -T app-web \
  sh -c 'printf %s "$ARUBA_CANARY_ENABLED"')
[ "$canary_enabled" = "false" ] || { echo "Gate opzionale del canary reale inatteso" >&2; exit 1; }
aruba_read_interval_ms=$(docker compose -f compose.yaml --env-file .env --env-file .deploy.env exec -T app-worker \
  sh -c 'printf %s "$ARUBA_API_READ_INTERVAL_MS"')
printf '%s' "$aruba_read_interval_ms" | grep -Eq '^[0-9]+$' \
  || { echo "Intervallo letture Aruba inatteso" >&2; exit 1; }
[ "$aruba_read_interval_ms" -ge 5200 ] && [ "$aruba_read_interval_ms" -le 6100 ] \
  || { echo "Intervallo letture Aruba fuori dal perimetro sicuro" >&2; exit 1; }

jq -n \
  --arg checkedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg commit "$APP_COMMIT_SHA" \
  --arg digest "$APP_IMAGE_DIGEST" \
  --arg version "$APP_VERSION" \
  --arg schema "$schema" \
  --argjson arubaApiReadIntervalMs "$aruba_read_interval_ms" \
  '{status:"ok",checkedAt:$checkedAt,commit:$commit,imageDigest:$digest,applicationVersion:$version,schema:$schema,arubaCanaryEnabled:false,arubaSubmissionEnabled:false,arubaApiReadIntervalMs:$arubaApiReadIntervalMs}'
