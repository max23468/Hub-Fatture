-- Ritenta i soli giri Aruba bloccati durante la materializzazione dei privati
-- esteri: la nuova verifica conserva il Paese necessario a riconoscere il
-- placeholder 99999999999 senza trasformarlo in un identificativo fiscale.
WITH retryable AS (
  SELECT id
  FROM jobs
  WHERE status = 'FAILED'
    AND last_error_code = 'ARUBA_PROFILE_CONFLICT'
    AND type IN (
      'aruba_backfill_inventory',
      'aruba_sync_inventory',
      'aruba_refresh_nonterminal',
      'aruba_full_inventory'
    )
  ORDER BY coalesce(locked_at, run_at, created_at) DESC, id DESC
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
