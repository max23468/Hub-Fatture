ALTER TABLE aruba_send_permits
  ADD COLUMN revoked_at timestamptz,
  ADD CONSTRAINT aruba_send_permits_terminal_state_check CHECK (
    consumed_at IS NULL OR revoked_at IS NULL
  );

-- Un permesso pilota non può sopravvivere al cambio di contratto che introduce
-- revoca e unicità globale. Il percorso applicativo precedente non ne creava,
-- ma l'upgrade resta fail-closed anche davanti a dati predisposti manualmente.
UPDATE aruba_send_permits
SET revoked_at = now(), expires_at = least(expires_at, now())
WHERE scope = 'CANARY' AND consumed_at IS NULL;

CREATE UNIQUE INDEX aruba_single_active_canary_permit_idx
  ON aruba_send_permits (scope)
  WHERE scope = 'CANARY' AND consumed_at IS NULL AND revoked_at IS NULL;
