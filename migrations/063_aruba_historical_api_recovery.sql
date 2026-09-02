ALTER TABLE aruba_api_targeted_run_groups
  RENAME TO aruba_api_targeted_run_targets;

ALTER TABLE aruba_api_targeted_run_targets
  RENAME COLUMN group_ordinal TO target_ordinal;

ALTER TABLE aruba_api_targeted_run_targets
  ALTER COLUMN provider_group_id DROP NOT NULL;

ALTER TABLE aruba_api_targeted_run_targets
  DROP CONSTRAINT aruba_api_targeted_run_groups_pkey,
  DROP CONSTRAINT aruba_api_targeted_run_groups_sync_run_id_provider_group_id_key;

ALTER TABLE aruba_api_targeted_run_targets
  ADD COLUMN remote_document_id bigint REFERENCES aruba_remote_documents(id),
  ADD COLUMN search_start timestamptz,
  ADD COLUMN search_end timestamptz,
  ADD CONSTRAINT aruba_api_targeted_run_targets_pkey
    PRIMARY KEY (sync_run_id, target_ordinal),
  ADD CONSTRAINT aruba_api_targeted_run_targets_kind_check CHECK (
    (provider_group_id IS NOT NULL
      AND remote_document_id IS NULL AND search_start IS NULL AND search_end IS NULL)
    OR
    (provider_group_id IS NULL
      AND remote_document_id IS NOT NULL AND search_start IS NOT NULL AND search_end IS NOT NULL
      AND search_end > search_start AND search_end <= search_start + interval '48 hours')
  );

CREATE UNIQUE INDEX aruba_api_targeted_run_targets_group_idx
  ON aruba_api_targeted_run_targets (sync_run_id, provider_group_id)
  WHERE provider_group_id IS NOT NULL;

CREATE UNIQUE INDEX aruba_api_targeted_run_targets_remote_idx
  ON aruba_api_targeted_run_targets (sync_run_id, remote_document_id)
  WHERE remote_document_id IS NOT NULL;

ALTER TABLE aruba_remote_documents
  ADD COLUMN historical_api_recovery_checked_at timestamptz,
  ADD COLUMN historical_api_recovery_result text,
  ADD CONSTRAINT aruba_remote_documents_historical_api_recovery_result_check CHECK (
    historical_api_recovery_result IS NULL
    OR historical_api_recovery_result IN ('RECOVERED', 'NOT_FOUND', 'AMBIGUOUS', 'GROUP_FILE_ONLY')
  );

COMMENT ON TABLE aruba_api_targeted_run_targets IS
  'Snapshot ordinato dei gruppi API e dei documenti legacy da recuperare con ricerca storica limitata.';

COMMENT ON COLUMN aruba_remote_documents.historical_api_recovery_result IS
  'Esito dell''ultimo recupero API limitato di un documento legacy privo di ID gruppo Aruba.';
