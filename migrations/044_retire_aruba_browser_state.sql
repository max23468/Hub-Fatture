UPDATE aruba_preflight_receipts
SET status = 'EXPIRED', completed_at = coalesce(completed_at, now()),
    expires_at = coalesce(expires_at, now())
WHERE source = 'HELPER' AND status IN ('REQUESTED', 'RUNNING');

ALTER TABLE aruba_preflight_receipts
  ALTER COLUMN source SET DEFAULT 'MANUAL',
  DROP CONSTRAINT aruba_preflight_receipts_source_check,
  ADD CONSTRAINT aruba_preflight_receipts_source_check CHECK (
    source IN ('HELPER', 'MANUAL', 'OWNER_OVERRIDE')
  );

ALTER TABLE aruba_sync_sessions
  ALTER COLUMN device_id DROP NOT NULL,
  ALTER COLUMN token_hash DROP NOT NULL;

UPDATE aruba_sync_sessions
SET device_id = NULL, token_hash = NULL, helper_version = NULL, browser_name = NULL
WHERE source = 'MANUAL';

ALTER TABLE aruba_sync_sessions
  ADD CONSTRAINT aruba_sync_sessions_source_runtime_check CHECK (
    (source = 'HELPER' AND device_id IS NOT NULL AND token_hash IS NOT NULL)
    OR (source = 'MANUAL' AND device_id IS NULL AND token_hash IS NULL
      AND helper_version IS NULL AND browser_name IS NULL)
  );

COMMENT ON COLUMN aruba_sync_sessions.source IS
  'HELPER identifica soltanto provenienza storica; le nuove ricevute operative sono MANUAL.';
