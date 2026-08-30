DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM connections
    WHERE provider = 'ARUBA' AND automatic_authority <> 'API'
  ) THEN
    RAISE EXCEPTION
      'Rimozione runtime browser bloccata: completare prima il cutover Aruba API';
  END IF;
END
$$;

UPDATE connections
SET automatic_authority = 'API'
WHERE provider <> 'ARUBA' AND automatic_authority <> 'API';

UPDATE aruba_sync_sessions
SET status = 'REVOKED',
    lease_expires_at = least(lease_expires_at, now()),
    error_code = coalesce(error_code, 'BROWSER_RUNTIME_REMOVED')
WHERE status IN ('ACTIVE', 'SCANNING');

UPDATE aruba_helper_tokens
SET revoked_at = coalesce(revoked_at, now()),
    expires_at = least(expires_at, now())
WHERE revoked_at IS NULL;

ALTER TABLE connections
  ALTER COLUMN automatic_authority SET DEFAULT 'API',
  DROP CONSTRAINT connections_automatic_authority_check,
  ADD CONSTRAINT connections_automatic_authority_check CHECK (
    automatic_authority = 'API'
  );

COMMENT ON COLUMN connections.automatic_authority IS
  'Autorità automatica esclusiva Aruba API; BROWSER resta soltanto nella provenienza storica.';
