ALTER TABLE orders DROP CONSTRAINT orders_trigger_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_trigger_status_check CHECK (
  trigger_status IN (
    'WAITING_FOR_TRIGGER',
    'ELIGIBLE',
    'GROUPED',
    'CANCELLED_NO_DOCUMENT',
    'REFUNDED_BEFORE_ISSUE',
    'INVOICED',
    'NEEDS_REVIEW'
  )
);
