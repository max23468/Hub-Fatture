ALTER TABLE aruba_batches
  DROP CONSTRAINT aruba_batches_status_check;

UPDATE aruba_batches
SET status = 'READY_AUTOMATIC', updated_at = now()
WHERE status = 'PERMIT_CONSUMED';

ALTER TABLE aruba_batches
  ADD CONSTRAINT aruba_batches_status_check CHECK (status IN (
    'PREPARED', 'HELPER_ACTIVE', 'VALIDATION_FAILED', 'READY_ASSISTED',
    'READY_AUTOMATIC', 'SUBMITTED', 'RECONCILIATION_REQUIRED', 'RECONCILED', 'CANCELLED'
  ));

DROP TABLE aruba_send_permits;
