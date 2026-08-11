ALTER TABLE refunds
  ADD COLUMN applied_before_issue boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT refunds_single_accounting_path_check CHECK (
    NOT (applied_before_issue AND credit_document_id IS NOT NULL)
  );

UPDATE refunds
SET applied_before_issue = true
FROM orders
JOIN billing_cases ON billing_cases.id = orders.billing_case_id
WHERE refunds.order_id = orders.id
  AND refunds.status = 'COMPLETED'
  AND refunds.amount > 0
  AND refunds.credit_document_id IS NULL
  AND billing_cases.status IN ('DRAFT', 'READY', 'NEEDS_REVIEW', 'DO_NOT_TRANSMIT');
