UPDATE jobs
SET payload_json = jsonb_set(
  payload_json,
  '{historical}',
  to_jsonb(coalesce((
    SELECT jobs.created_at <= sync_cursors.updated_at
    FROM sync_cursors
    WHERE provider = 'SHOPIFY' AND stream = 'history_import'
  ), true))
)
WHERE type = 'shopify_process_webhook'
  AND NOT (payload_json ? 'historical');
