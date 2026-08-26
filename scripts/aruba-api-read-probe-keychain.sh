#!/bin/sh

set -eu

keychain_service="it.hub-fatture.aruba-api"

cleanup() {
  unset aruba_api_password
}

trap cleanup EXIT HUP INT TERM

if ! command -v security >/dev/null 2>&1; then
  echo "Il probe con Portachiavi richiede macOS." >&2
  exit 1
fi

if [ -z "${ARUBA_API_USERNAME:-}" ] || [ -z "${ARUBA_API_EXPECTED_TAX_ID:-}" ]; then
  echo "Imposta ARUBA_API_USERNAME e ARUBA_API_EXPECTED_TAX_ID." >&2
  exit 1
fi

if ! aruba_api_password="$(
  security find-generic-password \
    -a "$ARUBA_API_USERNAME" \
    -s "$keychain_service" \
    -w 2>/dev/null
)"; then
  echo "Credenziale Aruba non trovata nel Portachiavi macOS." >&2
  exit 1
fi

printf '%s' "$aruba_api_password" | \
  ARUBA_API_ENVIRONMENT=PRODUCTION \
    ARUBA_API_USERNAME="$ARUBA_API_USERNAME" \
    ARUBA_API_EXPECTED_TAX_ID="$ARUBA_API_EXPECTED_TAX_ID" \
    node scripts/aruba-api-read-probe.ts
