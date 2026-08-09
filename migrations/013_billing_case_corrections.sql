ALTER TABLE audit_events
  ADD COLUMN before_json jsonb,
  ADD COLUMN after_json jsonb,
  ADD COLUMN reason text;

CREATE INDEX audit_events_order_case_idx
  ON audit_events ((metadata_json ->> 'billingCaseId'), created_at DESC)
  WHERE entity_type = 'ORDER';

CREATE INDEX audit_events_history_idx ON audit_events (created_at DESC, id DESC);

ALTER TABLE billing_cases
  ADD COLUMN revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  ADD COLUMN customer_corrected_at timestamptz;

CREATE INDEX customers_name_idx ON customers (lower(display_name));
CREATE INDEX customers_email_idx ON customers (lower(email)) WHERE email IS NOT NULL;

-- Separa le anomalie che una correzione anagrafica può risolvere da quelle che restano
-- dell'ordine: senza questa distinzione una preparazione corretta resterebbe da verificare.
UPDATE orders
SET normalized_snapshot_json = (normalized_snapshot_json - 'preparationReviewRequired')
  || jsonb_build_object(
       'orderReviewRequired',
       normalized_snapshot_json ->> 'paymentStatus' <> 'PAID'
         OR EXISTS (
           SELECT 1 FROM jsonb_array_elements(normalized_snapshot_json -> 'payments') AS payment
           WHERE payment ->> 'status' <> 'PAID'
         )
         OR NOT coalesce((normalized_snapshot_json ->> 'totalsReconciled')::boolean, false)
     );
