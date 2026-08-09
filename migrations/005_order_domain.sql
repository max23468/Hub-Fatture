INSERT INTO settings (key, value_json)
VALUES ('draft_trigger', '"PAID"'::jsonb)
ON CONFLICT (key) DO NOTHING;

CREATE TABLE customers (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('PRIVATE_IT', 'BUSINESS_IT', 'EU', 'UNKNOWN')),
  match_key text NOT NULL UNIQUE,
  display_name text NOT NULL,
  first_name text,
  last_name text,
  company_name text,
  email text,
  phone text,
  tax_id_type text,
  tax_id_normalized text,
  vat_country text,
  billing_address_json jsonb NOT NULL,
  source_confidence text NOT NULL CHECK (source_confidence IN ('TAX_ID', 'EXACT_PROFILE', 'AMBIGUOUS')),
  review_required boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE customer_source_records (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id bigint NOT NULL REFERENCES customers(id),
  provider text NOT NULL CHECK (provider IN ('SHOPIFY', 'EBAY')),
  external_customer_id text NOT NULL,
  raw_snapshot_json jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, external_customer_id)
);

CREATE TABLE billing_cases (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_number text GENERATED ALWAYS AS ('S-' || lpad(id::text, 6, '0')) STORED UNIQUE,
  customer_id bigint NOT NULL REFERENCES customers(id),
  local_order_date date NOT NULL,
  currency text NOT NULL CHECK (currency = 'EUR'),
  status text NOT NULL CHECK (status IN ('DRAFT', 'NEEDS_REVIEW', 'READY', 'DO_NOT_TRANSMIT', 'APPROVED', 'CLOSED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX billing_cases_open_group_idx
  ON billing_cases (customer_id, local_order_date, currency)
  WHERE status IN ('DRAFT', 'NEEDS_REVIEW', 'READY');

CREATE TABLE orders (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider text NOT NULL CHECK (provider IN ('SHOPIFY', 'EBAY')),
  external_account_id text NOT NULL,
  external_order_id text NOT NULL,
  display_number text NOT NULL,
  created_at_source timestamptz NOT NULL,
  updated_at_source timestamptz NOT NULL,
  local_order_date date NOT NULL,
  currency text NOT NULL CHECK (currency = 'EUR'),
  gross_amount integer NOT NULL CHECK (gross_amount >= 0),
  payment_status text NOT NULL CHECK (payment_status IN ('PAID', 'PENDING', 'REFUNDED')),
  fulfillment_status text NOT NULL CHECK (fulfillment_status IN ('UNFULFILLED', 'PARTIAL', 'FULFILLED')),
  trigger_status text NOT NULL CHECK (trigger_status IN ('WAITING_FOR_TRIGGER', 'ELIGIBLE', 'GROUPED', 'CANCELLED_NO_DOCUMENT', 'NEEDS_REVIEW')),
  customer_id bigint NOT NULL REFERENCES customers(id),
  billing_case_id bigint REFERENCES billing_cases(id),
  raw_snapshot_json jsonb NOT NULL,
  normalized_snapshot_json jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  last_synced_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz,
  UNIQUE (provider, external_account_id, external_order_id)
);

CREATE INDEX orders_status_date_idx ON orders (trigger_status, local_order_date DESC);
CREATE INDEX orders_customer_idx ON orders (customer_id, local_order_date DESC);
CREATE INDEX orders_case_idx ON orders (billing_case_id);

CREATE TABLE order_lines (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id bigint NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  external_line_id text NOT NULL,
  description text NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  gross_amount integer NOT NULL CHECK (gross_amount >= 0),
  discount_amount integer NOT NULL CHECK (discount_amount >= 0),
  raw_json jsonb NOT NULL,
  UNIQUE (order_id, external_line_id)
);

CREATE TABLE order_tax_identifiers (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id bigint NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  type text NOT NULL,
  raw_value text NOT NULL,
  normalized_value text NOT NULL,
  source_field text NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, type, normalized_value)
);

CREATE TABLE payments (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id bigint NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  external_payment_id text NOT NULL,
  method text NOT NULL,
  status text NOT NULL CHECK (status IN ('PAID', 'PENDING', 'REFUNDED')),
  amount integer NOT NULL CHECK (amount >= 0),
  paid_at timestamptz,
  recorded_manually boolean NOT NULL DEFAULT false,
  raw_json jsonb NOT NULL,
  UNIQUE (order_id, external_payment_id)
);
