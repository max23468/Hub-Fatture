ALTER TABLE order_source_revisions
  DROP CONSTRAINT order_source_revisions_order_id_fkey,
  ADD CONSTRAINT order_source_revisions_order_id_fkey
    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE;

ALTER TABLE webhook_events
  ADD COLUMN request_payload_json jsonb NOT NULL DEFAULT '{}',
  DROP CONSTRAINT webhook_events_status_check,
  ADD CONSTRAINT webhook_events_status_check
    CHECK (status IN ('PENDING', 'PROCESSING', 'PROCESSED', 'FAILED'));
