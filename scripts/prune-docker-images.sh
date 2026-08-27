#!/bin/sh
set -eu

mode=apply
case "${1:-}" in
  "") ;;
  --dry-run) mode=dry-run ;;
  *) echo "Uso: prune-docker-images.sh [--dry-run]" >&2; exit 2 ;;
esac

root=${HUB_FATTURE_ROOT:-/opt/hub-fatture}
shared_lock=${SHARED_DOCKER_LOCK:-/run/lock/hub-fatture-sequent-docker.lock}
repository_source=https://github.com/max23468/Hub-Fatture
repository_image=ghcr.io/max23468/hub-fatture

read_digest() {
  file=$1
  awk -F= '
    $1 == "APP_IMAGE_DIGEST" { count += 1; value = $2 }
    END { if (count != 1) exit 1; print value }
  ' "$file"
}

is_protected() {
  candidate=$1
  [ "$candidate" = "$live_id" ] || [ "$candidate" = "$rollback_id" ] \
    || printf '%s\n' "$running_ids" | grep -Fqx "$candidate"
}

cd "$root"
[ -f .deploy.env ] || { echo "Configurazione live assente" >&2; exit 1; }
[ -f data/operations/rollback.env ] \
  || { echo "Configurazione rollback assente" >&2; exit 1; }

live_digest=$(read_digest .deploy.env) \
  || { echo "Digest live non univoco" >&2; exit 1; }
rollback_digest=$(read_digest data/operations/rollback.env) \
  || { echo "Digest rollback non univoco" >&2; exit 1; }
for digest in "$live_digest" "$rollback_digest"; do
  printf '%s' "$digest" | grep -Eq '^sha256:[0-9a-f]{64}$' \
    || { echo "Digest protetto non valido" >&2; exit 1; }
done

exec 8>./backup.lock
flock -n 8 || { echo "Un backup o deploy Hub Fatture è già in corso" >&2; exit 1; }
exec 9>"$shared_lock"
flock -n 9 || { echo "Una build o manutenzione Docker condivisa è già in corso" >&2; exit 1; }

live_ref="$repository_image@$live_digest"
rollback_ref="$repository_image@$rollback_digest"
live_id=$(docker image inspect --format '{{.Id}}' "$live_ref") \
  || { echo "Immagine live protetta assente" >&2; exit 1; }
rollback_id=$(docker image inspect --format '{{.Id}}' "$rollback_ref") \
  || { echo "Immagine rollback protetta assente" >&2; exit 1; }

running_ids=
for container in $(docker ps -aq); do
  container_image=$(docker inspect --format '{{.Image}}' "$container")
  running_ids="${running_ids}${running_ids:+
}${container_image}"
done

removed=0
for image_id in $(docker image ls --no-trunc -aq | sort -u); do
  source=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.source"}}' \
    "$image_id")
  [ "$source" = "$repository_source" ] || continue
  is_protected "$image_id" && continue
  if [ "$mode" = dry-run ]; then
    printf 'Rimuoverebbe %s\n' "$image_id"
  else
    docker image rm "$image_id" >/dev/null
  fi
  removed=$((removed + 1))
done

docker image inspect "$live_ref" "$rollback_ref" >/dev/null
usage=$(df -P "$root" | awk 'NR == 2 { print $5 }')
printf 'Pulizia immagini Hub Fatture: modalità=%s candidate=%s uso-disco=%s\n' \
  "$mode" "$removed" "$usage"
