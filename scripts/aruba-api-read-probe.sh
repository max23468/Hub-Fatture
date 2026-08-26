#!/bin/sh

set -eu

cleanup() {
  stty echo 2>/dev/null || true
  unset aruba_api_username aruba_api_password aruba_api_expected_tax_id
}

trap cleanup EXIT HUP INT TERM

if [ ! -t 0 ]; then
  echo "Il probe interattivo richiede un Terminale." >&2
  exit 1
fi

printf "Username dell'utenza Aruba Base: "
IFS= read -r aruba_api_username

printf "Password Aruba (non verrà mostrata): "
stty -echo
IFS= read -r aruba_api_password
stty echo
printf "\n"

printf "P.IVA o codice fiscale atteso dell'utenza Base: "
IFS= read -r aruba_api_expected_tax_id

printf '%s' "$aruba_api_password" | \
  ARUBA_API_ENVIRONMENT=PRODUCTION \
    ARUBA_API_USERNAME="$aruba_api_username" \
    ARUBA_API_EXPECTED_TAX_ID="$aruba_api_expected_tax_id" \
    node scripts/aruba-api-read-probe.ts
