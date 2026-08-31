#!/bin/sh
set -eu

mode=blocking
case "${1:-}" in
  "") ;;
  --report-only) mode=report-only ;;
  *) echo "Uso: monitor-local.sh [--report-only]" >&2; exit 2 ;;
esac

root=${HUB_FATTURE_ROOT:-/opt/hub-fatture}
cd "$root"
# shellcheck disable=SC1091
. ./scripts/read-env.sh
notifications_topic=$(env_value .env OCI_NOTIFICATIONS_TOPIC_OCID)
backup_bucket=$(env_value .env OCI_BACKUP_BUCKET)
oci_namespace=$(env_value .env OCI_NAMESPACE)
set -a
. ./.deploy.env
set +a

sum_object_bytes() {
  jq -er '[.data[]?.size // 0] | add // 0'
}

problem=
add_problem() {
  if [ -n "$problem" ]; then
    problem="$problem
$1"
  else
    problem=$1
  fi
}

running=$(docker compose -f compose.yaml --env-file .env --env-file .deploy.env ps \
  --status running --services)
for service in app-web app-worker caddy postgres; do
  printf '%s\n' "$running" | grep -qx "$service" \
    || add_problem "$service non in esecuzione"
done
for service in app-web postgres; do
  health=$(docker compose -f compose.yaml --env-file .env --env-file .deploy.env ps \
    --format json "$service" | jq -r '.Health // empty')
  [ "$health" = "healthy" ] || add_problem "$service non sano: ${health:-assente}"
done
use=$(df -P "$root" | awk 'NR == 2 { gsub(/%/, "", $5); print $5 }')
[ "$use" -lt 85 ] || add_problem "spazio disco oltre 85%"
backup_warning_bytes=${OCI_BACKUP_WARNING_BYTES:-15000000000}
case "$backup_warning_bytes" in
  *[!0-9]* | "") add_problem "soglia bucket backup non valida" ;;
  *)
    if objects=$(oci os object list --auth instance_principal --namespace "$oci_namespace" \
      --bucket-name "$backup_bucket" --all 2>/dev/null) \
      && bucket_bytes=$(printf '%s' "$objects" | sum_object_bytes); then
      [ "$bucket_bytes" -lt "$backup_warning_bytes" ] \
        || add_problem "bucket backup oltre soglia prudenziale"
    else
      add_problem "uso bucket backup non rilevabile"
    fi
    ;;
esac
if [ -f data/operations/backup-receipt.json ]; then
  completed=$(jq -r '.completedAt // empty' data/operations/backup-receipt.json)
  if completed_epoch=$(date -u -d "$completed" +%s 2>/dev/null); then
    age_seconds=$(( $(date -u +%s) - completed_epoch ))
    [ "$age_seconds" -lt 129600 ] || add_problem "backup più vecchio di 36 ore"
  else
    add_problem "ricevuta backup non valida"
  fi
else
  add_problem "ricevuta backup assente"
fi

state_path=data/operations/monitor-state
previous=$(cat "$state_path" 2>/dev/null || true)
current=${problem:-ok}
if [ "$current" != "$previous" ]; then
  if [ -n "$notifications_topic" ]; then
    if [ -n "$problem" ]; then
      title="Hub Fatture: monitor locale"
      body=$problem
    elif [ -n "$previous" ] && [ "$previous" != "ok" ]; then
      title="Hub Fatture: monitor ripristinato"
      body="I controlli locali della Production sono tornati sani."
    fi
    if [ -n "${title:-}" ]; then
      oci ons message publish --auth instance_principal --topic-id "$notifications_topic" \
        --title "$title" --body "$body" >/dev/null
    fi
  fi
  printf '%s\n' "$current" >"$state_path.next"
  chmod 640 "$state_path.next"
  mv "$state_path.next" "$state_path"
fi

if [ -n "$problem" ]; then
  echo "$problem" >&2
  [ "$mode" = report-only ] || exit 1
  echo "Monitor locale con anomalie già notificate; il readback del deploy resta valido."
  exit 0
fi
echo "Monitor locale sano."
