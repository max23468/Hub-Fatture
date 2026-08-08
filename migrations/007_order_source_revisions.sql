ALTER TABLE orders DROP CONSTRAINT orders_trigger_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_trigger_status_check CHECK (
  trigger_status IN (
    'WAITING_FOR_TRIGGER',
    'ELIGIBLE',
    'GROUPED',
    'CANCELLED_NO_DOCUMENT',
    'REFUNDED_BEFORE_ISSUE',
    'NEEDS_REVIEW'
  )
);

ALTER TABLE billing_cases ADD COLUMN do_not_transmit_reason text;

CREATE TABLE order_source_revisions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id bigint NOT NULL REFERENCES orders(id),
  billing_case_id bigint NOT NULL REFERENCES billing_cases(id),
  previous_normalized_snapshot_json jsonb NOT NULL,
  current_normalized_snapshot_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX order_source_revisions_case_idx
  ON order_source_revisions (billing_case_id, created_at DESC);
