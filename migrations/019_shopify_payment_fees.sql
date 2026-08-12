INSERT INTO settings (key, value_json)
VALUES ('shopify_payment_fee_mode', '"DEDUCT"'::jsonb)
ON CONFLICT (key) DO NOTHING;

ALTER TABLE orders
  ADD COLUMN shopify_payments_fee_amount integer NOT NULL DEFAULT 0
    CHECK (shopify_payments_fee_amount >= 0),
  ADD COLUMN deducted_shopify_payments_fee_amount integer NOT NULL DEFAULT 0
    CHECK (deducted_shopify_payments_fee_amount >= 0),
  ADD COLUMN billable_amount integer GENERATED ALWAYS AS (
    gross_amount - deducted_shopify_payments_fee_amount
  ) STORED,
  ADD CONSTRAINT orders_shopify_payments_fee_not_above_gross
    CHECK (shopify_payments_fee_amount <= gross_amount),
  ADD CONSTRAINT orders_deducted_shopify_payments_fee_not_above_observed
    CHECK (deducted_shopify_payments_fee_amount <= shopify_payments_fee_amount);

ALTER TABLE payments
  ADD COLUMN shopify_payments_fee_amount integer NOT NULL DEFAULT 0
    CHECK (shopify_payments_fee_amount >= 0),
  ADD CONSTRAINT payments_shopify_payments_fee_not_above_amount
    CHECK (shopify_payments_fee_amount <= amount);
