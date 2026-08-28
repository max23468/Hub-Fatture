#!/bin/sh
set -eu

umask 077

script_path=$0
while [ -L "$script_path" ]; do
  link_target=$(readlink "$script_path")
  case "$link_target" in
    /*) script_path=$link_target ;;
    *) script_path=$(dirname -- "$script_path")/$link_target ;;
  esac
done
root=$(CDPATH='' cd -- "$(dirname -- "$script_path")/.." && pwd)
encrypted_key=${HUB_FATTURE_SSH_KEY_AGE:-"$root/ops/secrets/oci-vps-access.key.age"}
recovery_dir=${HUB_FATTURE_RECOVERY_DIR:-"$HOME/Documents/Hub-Fatture-Recovery"}
age_identity=${HUB_FATTURE_AGE_IDENTITY:-"$recovery_dir/age-identity.txt"}
ssh_host=${HUB_FATTURE_SSH_HOST:-fatture.opik.net}
ssh_user=${HUB_FATTURE_SSH_USER:-ubuntu}

fail() {
  echo "$1" >&2
  exit 1
}

for required_command in age ssh ssh-add ssh-agent; do
  command -v "$required_command" >/dev/null 2>&1 \
    || fail "Comando richiesto assente: $required_command"
done

[ -f "$encrypted_key" ] || fail "Blob SSH cifrato assente"
[ -f "$age_identity" ] || fail "Identità age del recovery kit assente"

temporary_dir=$(mktemp -d "${TMPDIR:-/tmp}/hub-fatture-ssh.XXXXXX")
export SSH_AUTH_SOCK="$temporary_dir/agent.sock"

# Invocata indirettamente dai trap.
# shellcheck disable=SC2329
cleanup() {
  ssh-agent -k >/dev/null 2>&1 || true
  rm -rf "$temporary_dir"
}
trap cleanup EXIT HUP INT TERM

agent_environment=$(ssh-agent -a "$SSH_AUTH_SOCK" -s)
eval "$agent_environment" >/dev/null

if ! age --decrypt -i "$age_identity" "$encrypted_key" 2>/dev/null \
  | ssh-add - >/dev/null 2>&1; then
  fail "Impossibile caricare la chiave SSH dal recovery kit"
fi

# Il file pubblico temporaneo limita l'offerta alla sola identità appena caricata
# senza scrivere su disco la chiave privata decifrata.
ssh-add -L >"$temporary_dir/identity.pub"

set +e
ssh -o BatchMode=yes -o IdentitiesOnly=yes -o IdentityAgent="$SSH_AUTH_SOCK" \
  -i "$temporary_dir/identity.pub" "$ssh_user@$ssh_host" "$@"
status=$?
set -e
exit "$status"
