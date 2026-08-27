ALTER TABLE connections
  DROP CONSTRAINT connections_automatic_authority_check,
  ADD CONSTRAINT connections_automatic_authority_check CHECK (
    automatic_authority IN ('BROWSER', 'API')
  );

ALTER TABLE aruba_sync_runs
  DROP CONSTRAINT aruba_sync_runs_authority_mode_check,
  ADD CONSTRAINT aruba_sync_runs_authority_mode_check CHECK (
    authority_mode IN ('SHADOW', 'CANONICAL')
  );

ALTER TABLE aruba_remote_observations
  ADD COLUMN payload_json jsonb,
  ADD CONSTRAINT aruba_remote_observations_payload_check CHECK (
    payload_json IS NULL OR jsonb_typeof(payload_json) = 'object'
  );

CREATE TABLE aruba_api_group_files (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sync_run_id uuid NOT NULL REFERENCES aruba_sync_runs(id),
  provider_group_id text NOT NULL CHECK (length(provider_group_id) BETWEEN 1 AND 200),
  storage_object_id bigint NOT NULL UNIQUE REFERENCES storage_objects(id),
  kind text NOT NULL CHECK (kind IN ('ARUBA_XML', 'ARUBA_P7M', 'ARUBA_PDF')),
  provider_filename text NOT NULL CHECK (length(provider_filename) BETWEEN 1 AND 500),
  imported_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sync_run_id, provider_group_id, kind)
);

CREATE INDEX aruba_api_group_files_lookup_idx
  ON aruba_api_group_files (sync_run_id, provider_group_id);

CREATE TABLE aruba_api_shadow_group_files (
  sync_run_id uuid NOT NULL REFERENCES aruba_sync_runs(id) ON DELETE CASCADE,
  provider_group_id text NOT NULL CHECK (length(provider_group_id) BETWEEN 1 AND 200),
  kind text NOT NULL CHECK (kind IN ('ARUBA_XML', 'ARUBA_P7M', 'ARUBA_PDF')),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (sync_run_id, provider_group_id, kind)
);

COMMENT ON COLUMN connections.automatic_authority IS
  'Unica fonte automatica dell''inventario Aruba; il cambio avviene nella transazione di cutover.';

COMMENT ON COLUMN aruba_sync_runs.authority_mode IS
  'SHADOW prima del cutover, CANONICAL soltanto quando l''autorità automatica è API.';

COMMENT ON TABLE aruba_api_group_files IS
  'Artefatti ufficiali restituiti da Aruba per un gruppo multi-documento e non attribuibili a una singola fattura.';

COMMENT ON TABLE aruba_api_shadow_group_files IS
  'Impronte degli artefatti condivisi osservati durante la qualifica shadow, mantenute a livello di gruppo.';
