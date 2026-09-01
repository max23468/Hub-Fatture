-- Rilegge i soli conflitti eBay rimasti aperti dopo che lo stesso payload ha
-- permesso al mapper di ricostruire deterministicamente un rimborso ambiguo.
WITH affected_window AS (
  SELECT min(orders.updated_at_source) - interval '5 minutes' AS overlap_from
  FROM orders
  WHERE orders.provider = 'EBAY'
    AND coalesce(
      (orders.normalized_snapshot_json ->> 'sourceConflictRequired')::boolean,
      false
    )
    AND NOT coalesce(
      (orders.normalized_snapshot_json ->> 'orderReviewRequired')::boolean,
      true
    )
    AND EXISTS (
      SELECT 1
      FROM order_source_revisions revision
      CROSS JOIN LATERAL jsonb_array_elements(
        coalesce(revision.previous_normalized_snapshot_json -> 'refunds', '[]'::jsonb)
      ) previous_refund
      CROSS JOIN LATERAL jsonb_array_elements(
        coalesce(revision.current_normalized_snapshot_json -> 'refunds', '[]'::jsonb)
      ) current_refund
      WHERE revision.order_id = orders.id
        AND revision.id = (
          SELECT max(latest.id) FROM order_source_revisions latest
          WHERE latest.order_id = orders.id
        )
        AND revision.previous_normalized_snapshot_json -> 'sourceSnapshot'
          = revision.current_normalized_snapshot_json -> 'sourceSnapshot'
        AND revision.current_normalized_snapshot_json ->> 'reviewFingerprint'
          = orders.normalized_snapshot_json ->> 'reviewFingerprint'
        AND previous_refund ->> 'externalRefundId'
          = current_refund ->> 'externalRefundId'
        AND previous_refund ->> 'status' = 'AMBIGUOUS'
        AND previous_refund -> 'amount' = 'null'::jsonb
        AND current_refund ->> 'status' = 'COMPLETED'
        AND nullif(current_refund ->> 'amount', '') IS NOT NULL
        AND previous_refund -> 'raw' = current_refund -> 'raw'
        AND previous_refund -> 'completedAt'
          IS NOT DISTINCT FROM current_refund -> 'completedAt'
    )
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
