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

COMMENT ON COLUMN connections.automatic_authority IS
  'Unica fonte automatica dell''inventario Aruba; il cambio avviene nella transazione di cutover.';

COMMENT ON COLUMN aruba_sync_runs.authority_mode IS
  'SHADOW prima del cutover, CANONICAL soltanto quando l''autorità automatica è API.';
