#!/bin/sh
set -eu

root=${HUB_FATTURE_ROOT:-/opt/hub-fatture}
cd "$root"

receipt=$(HUB_FATTURE_ROOT="$root" ./scripts/production-readback.sh)
state=$(docker compose -f compose.yaml --env-file .env --env-file .deploy.env exec -T postgres \
  psql -U hub_fatture -d hub_fatture -At -F '|' -c "
    SELECT
      (SELECT count(*) FROM documents WHERE status = 'APPROVED' AND origin = 'HUB'),
      (SELECT count(*) FROM orders
       WHERE coalesce((normalized_snapshot_json ->> 'historical')::boolean, false)
         AND ((historical_reconciliation_outcome IS NULL
             AND (trigger_status <> 'LEGACY_BILLING_REVIEW'
               OR historical_reconciled_at IS NOT NULL
               OR billing_case_id IS NOT NULL
               OR EXISTS (
                 SELECT 1 FROM document_orders
                 WHERE document_orders.order_id = orders.id)))
           OR (historical_reconciliation_outcome = 'ALREADY_INVOICED'
             AND NOT EXISTS (
               SELECT 1 FROM document_orders
               JOIN documents ON documents.id = document_orders.document_id
               WHERE document_orders.order_id = orders.id
                 AND documents.origin = 'ARUBA_HISTORY')))),
      (SELECT count(*) FROM (VALUES ('SHOPIFY'), ('EBAY')) AS expected(provider)
       WHERE NOT EXISTS (
         SELECT 1 FROM connections
         WHERE connections.provider = expected.provider
           AND connections.environment = 'PRODUCTION'
           AND connections.status = 'CONNECTED'
           AND EXISTS (
             SELECT 1 FROM sync_cursors
             WHERE sync_cursors.provider = connections.provider
               AND sync_cursors.stream = 'history_import'))),
      (SELECT count(*) FROM aruba_batches
       WHERE status NOT IN ('RECONCILED', 'CANCELLED')),
      (SELECT count(*) FROM aruba_send_permits
       WHERE consumed_at IS NULL AND revoked_at IS NULL AND expires_at > now())")

IFS='|' read -r approved_documents unreconciled_history pending_history_imports open_aruba_batches active_permits <<EOF
$state
EOF

[ "$approved_documents" = "0" ] || { echo "Documenti approvati presenti" >&2; exit 1; }
[ "$unreconciled_history" = "0" ] || { echo "Ordini storici non riconciliati presenti" >&2; exit 1; }
[ "$pending_history_imports" = "0" ] || { echo "Import iniziali non completati" >&2; exit 1; }
[ "$open_aruba_batches" = "0" ] || { echo "Batch Aruba aperti presenti" >&2; exit 1; }
[ "$active_permits" = "0" ] || { echo "Permessi Aruba attivi presenti" >&2; exit 1; }

jq -n \
  --argjson deploy "$receipt" \
  --argjson approvedDocuments "$approved_documents" \
  --argjson unreconciledHistory "$unreconciled_history" \
  --argjson pendingHistoryImports "$pending_history_imports" \
  --argjson openArubaBatches "$open_aruba_batches" \
  --argjson activeArubaPermits "$active_permits" \
  '{status:"ok",deploy:$deploy,approvedDocuments:$approvedDocuments,
    unreconciledHistory:$unreconciledHistory,pendingHistoryImports:$pendingHistoryImports,
    openArubaBatches:$openArubaBatches,
    activeArubaPermits:$activeArubaPermits}'
