CREATE TABLE aruba_api_targeted_run_groups (
  sync_run_id uuid NOT NULL REFERENCES aruba_sync_runs(id) ON DELETE CASCADE,
  group_ordinal integer NOT NULL CHECK (group_ordinal > 0),
  provider_group_id text NOT NULL CHECK (length(provider_group_id) BETWEEN 1 AND 200),
  PRIMARY KEY (sync_run_id, group_ordinal),
  UNIQUE (sync_run_id, provider_group_id)
);

COMMENT ON TABLE aruba_api_targeted_run_groups IS
  'Snapshot ordinato dei gruppi Aruba di un run mirato, usato per riprese API idempotenti.';
