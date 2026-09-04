#!/bin/sh
set -eu

mode=${1:-}
expected_commit=${2:-}
case "$mode" in
  enable) target=true ;;
  disable) target=false ;;
  *) echo "Uso: $0 <enable|disable> <commit-live-40-caratteri>" >&2; exit 2 ;;
esac
printf '%s' "$expected_commit" | grep -Eq '^[0-9a-f]{40}$' \
  || { echo "Commit live atteso non valido" >&2; exit 2; }

root=${HUB_FATTURE_ROOT:-/opt/hub-fatture}
cd "$root"
[ -f .env ] && [ -f .deploy.env ] && [ -f data/operations/deploy-receipt.json ] \
  || { echo "Configurazione o ricevuta Production assente" >&2; exit 1; }
[ "$(stat -c %a .env)" = "600" ] || { echo "Permessi .env diversi da 600" >&2; exit 1; }

live_commit=$(jq -er .commit data/operations/deploy-receipt.json)
live_digest=$(jq -er .imageDigest data/operations/deploy-receipt.json)
live_version=$(jq -er .applicationVersion data/operations/deploy-receipt.json)
[ "$live_commit" = "$expected_commit" ] || { echo "Commit Production diverso dal candidato autorizzato" >&2; exit 1; }
printf '%s' "$live_version" | grep -Eq '^[1-9][0-9]*\.[0-9]+\.[0-9]+$' \
  || { echo "L'uso ordinario richiede una release stabile" >&2; exit 1; }
printf '%s' "$live_digest" | grep -Eq '^sha256:[0-9a-f]{64}$' \
  || { echo "Digest Production non valido" >&2; exit 1; }

line_count=$(grep -c '^ARUBA_SUBMISSION_ENABLED=' .env || true)
[ "$line_count" = "1" ] \
  || { echo "ARUBA_SUBMISSION_ENABLED deve comparire una sola volta" >&2; exit 1; }
current=$(sed -n 's/^ARUBA_SUBMISSION_ENABLED=//p' .env)
case "$current" in
  true | false) ;;
  *) echo "Valore ARUBA_SUBMISSION_ENABLED non valido" >&2; exit 1 ;;
esac

write_receipt() {
  receipt=$1
  install -d -m 750 data/operations
  printf '%s' "$receipt" | jq \
    --arg changedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg mode "$mode" \
    '. + {changedAt:$changedAt,operation:$mode}' \
    >data/operations/aruba-submission-mode-receipt.json.next
  chown 10001:10001 data/operations/aruba-submission-mode-receipt.json.next
  chmod 640 data/operations/aruba-submission-mode-receipt.json.next
  mv data/operations/aruba-submission-mode-receipt.json.next \
    data/operations/aruba-submission-mode-receipt.json
}

if [ "$current" = "$target" ]; then
  receipt=$(./scripts/production-readback.sh "$target")
  write_receipt "$receipt"
  echo "Modalità invii Aruba già conforme: $target"
  exit 0
fi

exec 9>./backup.lock
flock -n 9 || { echo "Un backup o deploy è già in corso" >&2; exit 1; }

if [ "$target" = true ]; then
  readiness=$(docker compose -f compose.yaml --env-file .env --env-file .deploy.env exec -T app-web \
    node build-server/operations/release-candidate-readiness.js)
  printf '%s' "$readiness" | jq -e '
    .unreconciledDryRunAttempts == 0 and
    .unreconciledHistory == 0 and
    .pendingHistoryImports == 0 and
    .openArubaBatches == 0
  ' >/dev/null || { echo "Readiness operativa non compatibile con l'abilitazione" >&2; exit 1; }
  active_outbound_jobs=$(docker compose -f compose.yaml --env-file .env --env-file .deploy.env exec -T postgres \
    psql -U hub_fatture -d hub_fatture -Atc \
    "SELECT count(*) FROM jobs WHERE type = 'aruba_send_submission' AND status IN ('PENDING', 'RUNNING')")
  [ "$active_outbound_jobs" = "0" ] \
    || { echo "Job outbound Aruba attivi presenti" >&2; exit 1; }
fi

previous=$(mktemp .env.submission.previous.XXXXXX)
next=$(mktemp .env.submission.next.XXXXXX)
cp .env "$previous"

needs_rollback=false
rollback() {
  cp "$previous" .env
  chmod 600 .env
  docker compose -f compose.yaml --env-file .env --env-file .deploy.env up -d --wait --force-recreate app-web app-worker >/dev/null
  ./scripts/production-readback.sh "$current" >/dev/null
}
cleanup() {
  status=$?
  if [ "$needs_rollback" = true ]; then
    needs_rollback=false
    if rollback; then
      echo "Configurazione precedente ripristinata" >&2
    else
      echo "Rollback del kill switch non riuscito; intervenire come P0" >&2
    fi
  fi
  rm -f "$previous" "$next"
  exit "$status"
}
trap cleanup EXIT HUP INT TERM

if ! docker compose -f compose.yaml --env-file .env --env-file .deploy.env stop --timeout 180 app-web app-worker; then
  docker compose -f compose.yaml --env-file .env --env-file .deploy.env up -d --wait app-web app-worker >/dev/null || true
  echo "Arresto controllato dei servizi non riuscito" >&2
  exit 1
fi
needs_rollback=true

if [ "$target" = true ]; then
  open_batches=$(docker compose -f compose.yaml --env-file .env --env-file .deploy.env exec -T postgres \
    psql -U hub_fatture -d hub_fatture -Atc \
    "SELECT count(*) FROM aruba_batches WHERE status NOT IN ('RECONCILED', 'CANCELLED', 'DOCUMENT_ONLY')")
  active_outbound_jobs=$(docker compose -f compose.yaml --env-file .env --env-file .deploy.env exec -T postgres \
    psql -U hub_fatture -d hub_fatture -Atc \
    "SELECT count(*) FROM jobs WHERE type = 'aruba_send_submission' AND status IN ('PENDING', 'RUNNING')")
  if [ "$open_batches" != "0" ] || [ "$active_outbound_jobs" != "0" ]; then
    echo "Stato outbound cambiato durante l'arresto controllato" >&2
    exit 1
  fi
fi

awk -v target="$target" '
  BEGIN { changed = 0 }
  /^ARUBA_SUBMISSION_ENABLED=/ { print "ARUBA_SUBMISSION_ENABLED=" target; changed++; next }
  { print }
  END { if (changed != 1) exit 42 }
' .env >"$next" || { echo "Aggiornamento atomico del kill switch non riuscito" >&2; exit 1; }
chmod 600 "$next"
mv "$next" .env

if ! docker compose -f compose.yaml --env-file .env --env-file .deploy.env config --quiet \
  || ! docker compose -f compose.yaml --env-file .env --env-file .deploy.env up -d --wait --force-recreate app-web app-worker \
  || ! receipt=$(./scripts/production-readback.sh "$target"); then
  echo "Cambio modalità non riuscito" >&2
  exit 1
fi

write_receipt "$receipt"
needs_rollback=false
echo "Modalità invii Aruba aggiornata e riletta: $target"
