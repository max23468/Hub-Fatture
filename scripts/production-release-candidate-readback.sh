#!/bin/sh
set -eu

root=${HUB_FATTURE_ROOT:-/opt/hub-fatture}
cd "$root"

receipt=$(HUB_FATTURE_ROOT="$root" ./scripts/production-readback.sh)
state=$(docker compose -f compose.yaml --env-file .env --env-file .deploy.env exec -T app-web \
  node build-server/operations/release-candidate-readiness.js)

printf '%s' "$state" | jq -e '
  [
    .unreconciledDryRunAttempts,
    .unreconciledHistory,
    .pendingHistoryImports,
    .openArubaBatches
  ] | all(type == "number" and . >= 0 and floor == .)' >/dev/null \
  || { echo "Stato readiness non valido" >&2; exit 1; }

[ "$(printf '%s' "$state" | jq -r .unreconciledDryRunAttempts)" = "0" ] \
  || { echo "Dry-run Production non riconciliati presenti" >&2; exit 1; }
[ "$(printf '%s' "$state" | jq -r .unreconciledHistory)" = "0" ] \
  || { echo "Ordini storici non riconciliati presenti" >&2; exit 1; }
[ "$(printf '%s' "$state" | jq -r .pendingHistoryImports)" = "0" ] \
  || { echo "Import iniziali non completati" >&2; exit 1; }
[ "$(printf '%s' "$state" | jq -r .openArubaBatches)" = "0" ] \
  || { echo "Batch Aruba aperti presenti" >&2; exit 1; }

jq -n \
  --argjson deploy "$receipt" \
  --argjson state "$state" \
  '{status:"ok",deploy:$deploy} + $state'
