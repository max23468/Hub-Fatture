DROP VIEW aruba_api_latest_shadow_documents;
DROP TABLE aruba_inbound_parity_dossiers;
DROP TABLE aruba_api_shadow_group_files;
DROP TABLE aruba_api_shadow_documents;
DROP TABLE aruba_helper_tokens;

ALTER TABLE aruba_sync_sessions
  DROP CONSTRAINT aruba_sync_sessions_source_runtime_check,
  DROP COLUMN device_id,
  DROP COLUMN token_hash,
  DROP COLUMN helper_version,
  DROP COLUMN browser_name,
  DROP COLUMN scope,
  DROP COLUMN initial_cursor;

ALTER TABLE aruba_sync_sessions
  ALTER COLUMN source SET DEFAULT 'MANUAL';

ALTER TABLE aruba_batches
  ALTER COLUMN transport SET DEFAULT 'API';

ALTER TABLE aruba_submissions
  ALTER COLUMN transport SET DEFAULT 'API';

COMMENT ON COLUMN aruba_sync_sessions.source IS
  'Provenienza del readback: HELPER storico o MANUAL corrente; nessuno stato browser viene conservato.';

DELETE FROM retention_holds WHERE data_class = 'ARUBA_CREDENTIALS';

ALTER TABLE retention_holds
  DROP CONSTRAINT retention_holds_data_class_check,
  ADD CONSTRAINT retention_holds_data_class_check CHECK (data_class IN (
    'SOURCE_PAYLOADS', 'OPERATIONAL_JOBS', 'OPERATIONAL_AUDIT', 'CUSTOMER_EMAIL'
  ));
