#!/bin/sh
set -eu

root=${HUB_FATTURE_ROOT:-/opt/hub-fatture}
cd "$root"
# shellcheck disable=SC1091
. ./scripts/read-env.sh
notifications_topic=$(env_value .env OCI_NOTIFICATIONS_TOPIC_OCID)
set -a
. ./.deploy.env
set +a

problem=
running=$(docker compose -f compose.yaml --env-file .env --env-file .deploy.env ps \
  --status running --services)
for service in app-web app-worker caddy postgres; do
  printf '%s\n' "$running" | grep -qx "$service" \
    || problem=${problem:-"$service non in esecuzione"}
done
for service in app-web postgres; do
  health=$(docker compose -f compose.yaml --env-file .env --env-file .deploy.env ps \
    --format json "$service" | jq -r '.Health // empty')
  [ "$health" = "healthy" ] || problem=${problem:-"$service non sano: ${health:-assente}"}
done
use=$(df -P "$root" | awk 'NR == 2 { gsub(/%/, "", $5); print $5 }')
[ "$use" -lt 85 ] || problem=${problem:-"spazio disco oltre 85%"}
if [ -f data/operations/backup-receipt.json ]; then
  completed=$(jq -r '.completedAt // empty' data/operations/backup-receipt.json)
  if completed_epoch=$(date -u -d "$completed" +%s 2>/dev/null); then
    age_seconds=$(( $(date -u +%s) - completed_epoch ))
    [ "$age_seconds" -lt 129600 ] || problem=${problem:-"backup più vecchio di 36 ore"}
  else
    problem=${problem:-"ricevuta backup non valida"}
  fi
else
  problem=${problem:-"ricevuta backup assente"}
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
  exit 1
fi
echo "Monitor locale sano."
