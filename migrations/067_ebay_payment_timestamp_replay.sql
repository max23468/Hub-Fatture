-- Rilegge soltanto i conflitti eBay la cui ultima revisione candidata riguarda
-- il timestamp del pagamento. Il runtime applica poi il confronto completo e
-- fail-closed prima di chiudere automaticamente il controllo.
WITH latest_revisions AS (
  SELECT DISTINCT ON (revision.order_id)
         revision.order_id,
         revision.previous_normalized_snapshot_json AS previous_snapshot,
         revision.current_normalized_snapshot_json AS current_snapshot
  FROM order_source_revisions revision
  ORDER BY revision.order_id, revision.created_at DESC, revision.id DESC
), candidates AS (
  SELECT orders.updated_at_source
  FROM orders
  JOIN latest_revisions ON latest_revisions.order_id = orders.id
  WHERE orders.provider = 'EBAY'
    AND coalesce(
      (orders.normalized_snapshot_json ->> 'sourceConflictRequired')::boolean,
      false
    )
    AND NOT coalesce(
      (orders.normalized_snapshot_json ->> 'orderReviewRequired')::boolean,
      true
    )
    AND jsonb_array_length(
      coalesce(latest_revisions.previous_snapshot -> 'payments', '[]'::jsonb)
    ) = jsonb_array_length(
      coalesce(latest_revisions.current_snapshot -> 'payments', '[]'::jsonb)
    )
    AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements(latest_revisions.previous_snapshot -> 'payments')
        WITH ORDINALITY previous_payment(payment, position)
      JOIN jsonb_array_elements(latest_revisions.current_snapshot -> 'payments')
        WITH ORDINALITY current_payment(payment, position) USING (position)
      WHERE previous_payment.payment -> 'paidAt'
        IS DISTINCT FROM current_payment.payment -> 'paidAt'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_object_keys(
        latest_revisions.previous_snapshot || latest_revisions.current_snapshot
      ) key
      WHERE latest_revisions.previous_snapshot -> key
          IS DISTINCT FROM latest_revisions.current_snapshot -> key
        AND key NOT IN (
          'payments', 'reviewFingerprint', 'sourceConflictRequired', 'sourceSnapshot', 'updatedAt'
        )
    )
), affected_window AS (
  SELECT min(updated_at_source) - interval '5 minutes' AS overlap_from FROM candidates
)
INSERT INTO sync_cursors (provider, stream, cursor, overlap_from)
SELECT 'EBAY', 'orders', NULL, overlap_from
FROM affected_window
WHERE overlap_from IS NOT NULL
ON CONFLICT (provider, stream) DO UPDATE SET
  cursor = NULL,
  overlap_from = CASE
    WHEN sync_cursors.overlap_from IS NULL
      OR sync_cursors.overlap_from > EXCLUDED.overlap_from
      THEN EXCLUDED.overlap_from
    ELSE sync_cursors.overlap_from
  END,
  updated_at = now();

UPDATE connections
SET last_synced_at = NULL,
    updated_at = now()
WHERE provider = 'EBAY'
  AND EXISTS (
    SELECT 1 FROM sync_cursors
    WHERE sync_cursors.provider = 'EBAY'
      AND sync_cursors.stream = 'orders'
      AND sync_cursors.cursor IS NULL
  )
  AND EXISTS (
    SELECT 1 FROM sync_cursors
    WHERE sync_cursors.provider = 'EBAY'
      AND sync_cursors.stream = 'history_import'
  );
