-- Un retry Aruba esplicito deve poter usare credenziali ancora valide anche se
-- il tentativo precedente ha lasciato la connessione in ERROR. Il runtime
-- mantiene bloccati PAUSED, REAUTH_REQUIRED e REVOKED e ripristina CONNECTED
-- soltanto dopo il completamento del job.
WITH retryable AS (
  SELECT jobs.id
  FROM jobs
  WHERE jobs.status = 'FAILED'
    AND jobs.last_error_code = 'PROVIDER_NOT_CONFIGURED'
    AND jobs.type IN (
      'aruba_backfill_inventory',
      'aruba_sync_inventory',
      'aruba_refresh_nonterminal',
      'aruba_full_inventory'
    )
    AND EXISTS (
      SELECT 1
      FROM connections
      WHERE provider = 'ARUBA'
        AND status = 'ERROR'
        AND encrypted_credentials IS NOT NULL
        AND credentials_verified_at IS NOT NULL
        AND inbound_enabled
        AND NOT api_paused
    )
  ORDER BY coalesce(jobs.locked_at, jobs.run_at, jobs.created_at) DESC, jobs.id DESC
  LIMIT 1
)
UPDATE jobs
SET status = 'PENDING',
    run_at = now(),
    attempts = 0,
    locked_at = NULL,
    lease_expires_at = NULL,
    locked_by = NULL,
    claim_token = NULL,
    completed_at = NULL,
    last_error_code = NULL
FROM retryable
WHERE jobs.id = retryable.id;
