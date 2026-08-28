UPDATE aruba_sync_runs AS runs
SET status = 'CANCELLED', completed_at = NULL, lease_expires_at = now(),
    last_error_code = 'ARUBA_INVENTORY_CONFLICT',
    last_error_message_sanitized = 'Confronto P7M da ricalcolare'
WHERE runs.authority_mode = 'SHADOW'
  AND runs.status IN ('RUNNING', 'INCOMPLETE', 'COMPLETED')
  AND (
    EXISTS (
      SELECT 1 FROM aruba_api_shadow_documents AS documents
      WHERE documents.sync_run_id = runs.id AND documents.p7m_sha256 IS NOT NULL
    )
    OR EXISTS (
      SELECT 1 FROM aruba_api_shadow_group_files AS files
      WHERE files.sync_run_id = runs.id AND files.kind = 'ARUBA_P7M'
    )
  );

COMMENT ON COLUMN aruba_api_shadow_documents.p7m_sha256 IS
  'Impronta SHA-256 del payload XML estratto dal contenitore P7M.';

COMMENT ON COLUMN aruba_api_shadow_group_files.sha256 IS
  'Impronta del payload XML per P7M, altrimenti dei byte ricevuti da Aruba.';
