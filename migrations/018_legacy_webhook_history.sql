UPDATE jobs
SET payload_json = jsonb_set(payload_json, '{historical}', 'true'::jsonb)
WHERE type = 'shopify_process_webhook'
  AND NOT (payload_json ? 'historical');
