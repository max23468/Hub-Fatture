#!/bin/sh
set -eu

project_root="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
keychain_account="hub-fatture"
keychain_service="Hub Fatture Development Encryption"
bootstrap_service="Hub Fatture Development Bootstrap Token"

keychain_export() {
  value="$(security find-generic-password -a "$keychain_account" -s "$1" -w 2>/dev/null || true)"
  if [ -n "$value" ]; then
    export "$2=$value"
  fi
  unset value
}

if ! development_key="$(security find-generic-password -a "$keychain_account" -s "$keychain_service" -w 2>/dev/null)"; then
  development_key="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"
  security add-generic-password -U -a "$keychain_account" -s "$keychain_service" -w "$development_key" >/dev/null
fi

if [ "${#development_key}" -ne 43 ]; then
  echo "La chiave Development nel Portachiavi non è valida." >&2
  exit 1
fi

export CREDENTIALS_ENCRYPTION_KEY="$development_key"
unset development_key

if ! development_bootstrap_token="$(security find-generic-password -a "$keychain_account" -s "$bootstrap_service" -w 2>/dev/null)"; then
  development_bootstrap_token="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"
  security add-generic-password -U -a "$keychain_account" -s "$bootstrap_service" -w "$development_bootstrap_token" >/dev/null
fi

if [ "${#development_bootstrap_token}" -lt 32 ]; then
  echo "Il token di configurazione Development nel Portachiavi non è valido." >&2
  exit 1
fi

export ADMIN_BOOTSTRAP_TOKEN="$development_bootstrap_token"
unset development_bootstrap_token

keychain_export "Hub Fatture Development eBay Client ID" EBAY_CLIENT_ID
keychain_export "Hub Fatture Development eBay Client Secret" EBAY_CLIENT_SECRET
keychain_export "Hub Fatture Development eBay RuName" EBAY_RUNAME
keychain_export "Hub Fatture Development eBay Account Reference" EBAY_ACCOUNT_REFERENCE

cd "$project_root"
docker compose up -d --build --wait app app-worker caddy

if [ "${1:-}" = "shopify" ]; then
  export APP_ENV="development"
  export DATABASE_URL="postgres://hub_fatture:hub_fatture_local@127.0.0.1:5432/hub_fatture"
  export EBAY_ENVIRONMENT="sandbox"
  export SHOPIFY_SHOP="syncbay-dev.myshopify.com"
  exec npm run dev:shopify:cli -- --path "$project_root"
fi
