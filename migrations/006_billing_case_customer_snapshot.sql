ALTER TABLE billing_cases ADD COLUMN customer_snapshot_json jsonb;

UPDATE billing_cases
SET customer_snapshot_json = jsonb_build_object(
  'kind', customers.kind,
  'displayName', customers.display_name,
  'firstName', customers.first_name,
  'lastName', customers.last_name,
  'companyName', customers.company_name,
  'email', customers.email,
  'phone', customers.phone,
  'billingAddress', customers.billing_address_json,
  'sourceConfidence', customers.source_confidence,
  'reviewRequired', customers.review_required
)
FROM customers
WHERE customers.id = billing_cases.customer_id;

ALTER TABLE billing_cases ALTER COLUMN customer_snapshot_json SET NOT NULL;
