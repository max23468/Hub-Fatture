#!/bin/sh
set -eu

archive=
identity=
target=
database_url=
confirmation=
expected_sha=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --archive) archive=$2; shift 2 ;;
    --identity) identity=$2; shift 2 ;;
    --target) target=$2; shift 2 ;;
    --database-url) database_url=$2; shift 2 ;;
    --sha256) expected_sha=$2; shift 2 ;;
    --confirm) confirmation=$2; shift 2 ;;
    *) echo "Argomento restore non riconosciuto" >&2; exit 2 ;;
  esac
done

[ -f "$archive" ] || { echo "Archivio cifrato assente" >&2; exit 2; }
[ -f "$identity" ] || { echo "Identità age assente" >&2; exit 2; }
[ -n "$target" ] && [ "$target" != "/" ] || { echo "Target restore non valido" >&2; exit 2; }
[ -n "$database_url" ] || { echo "Database target assente" >&2; exit 2; }
printf '%s' "$expected_sha" | grep -Eq '^[0-9a-f]{64}$' \
  || { echo "Checksum atteso non valido" >&2; exit 2; }
[ "$confirmation" = "RESTORE:$target" ] \
  || { echo "Conferma richiesta: RESTORE:$target" >&2; exit 2; }
[ ! -e "$target" ] || { echo "Il target esiste già: restore rifiutato" >&2; exit 1; }
[ "$(sha256sum "$archive" | awk '{print $1}')" = "$expected_sha" ] \
  || { echo "Checksum archivio non valido" >&2; exit 1; }

umask 077
mkdir -p "$target"
cleanup() {
  status=$?
  rm -f "$target/database.dump"
  exit "$status"
}
trap cleanup EXIT HUP INT TERM
age --decrypt --identity "$identity" "$archive" | tar -C "$target" -xf -
pg_restore --exit-on-error --no-owner --no-privileges --dbname "$database_url" \
  "$target/database.dump"
[ -f "$target/manifest.json" ] || { echo "Manifest restore assente" >&2; exit 1; }
trap - EXIT HUP INT TERM
rm -f "$target/database.dump"
echo "Restore completato e pronto per health/login nel target: $target"
