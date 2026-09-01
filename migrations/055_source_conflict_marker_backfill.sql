-- Conserva i conflitti sorgente reali già aperti prima dell'introduzione del
-- marcatore esplicito. I replay del mapper, che cambiano soltanto la proiezione
-- normalizzata lasciando invariato lo snapshot provider, restano esclusi.
WITH latest_revision AS (
  SELECT DISTINCT ON (order_source_revisions.order_id)
         order_source_revisions.order_id,
         order_source_revisions.previous_normalized_snapshot_json,
         order_source_revisions.current_normalized_snapshot_json
  FROM order_source_revisions
  ORDER BY order_source_revisions.order_id, order_source_revisions.created_at DESC
)
UPDATE orders
SET normalized_snapshot_json = jsonb_set(
      normalized_snapshot_json,
      '{sourceConflictRequired}',
      'true'::jsonb
    )
FROM latest_revision
WHERE orders.id = latest_revision.order_id
  AND orders.trigger_status = 'NEEDS_REVIEW'
  AND latest_revision.previous_normalized_snapshot_json -> 'sourceSnapshot'
      IS DISTINCT FROM
      latest_revision.current_normalized_snapshot_json -> 'sourceSnapshot';
