-- Baseline dello schema. Consolida la storia incrementale precedente alla prima release
-- Production: il numero pubblico delle preparazioni era stato ridefinito tre volte e diversi
-- vincoli erano arrivati per ALTER successivi. Qui vale soltanto lo stato finale.
-- Le migrazioni di soli dati che quella storia conteneva non compaiono: su uno schema vuoto
-- non hanno effetto.

CREATE TABLE users (
  id smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username text NOT NULL UNIQUE CHECK (username IN ('matteo', 'codex')),
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

CREATE TABLE sessions (
  id_hash text PRIMARY KEY,
  user_id smallint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);

CREATE TABLE settings (
  key text PRIMARY KEY,
  value_json jsonb NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO settings (key, value_json)
VALUES ('draft_trigger', '"PAID"'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- La soglia per solo username non può distinguere il titolare dall'attaccante: o esclude
-- entrambi, o non limita nessuno dei due. La dimensione per origine è la misura antiabuso
-- osservata che 17.4 richiede prima di raccogliere un `ip_hash`.
CREATE TABLE login_attempts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username text NOT NULL,
  successful boolean NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT now(),
  ip_hash text NOT NULL DEFAULT ''
);

CREATE INDEX login_attempts_rate_limit_idx ON login_attempts (username, attempted_at DESC);
CREATE INDEX login_attempts_origin_idx ON login_attempts (ip_hash, attempted_at DESC);

CREATE TABLE audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_type text NOT NULL,
  actor_id text,
  action text NOT NULL,
  event_class text NOT NULL CHECK (event_class IN ('CRITICAL', 'OPERATIONAL')),
  entity_type text NOT NULL,
  entity_id text,
  metadata_json jsonb NOT NULL DEFAULT '{}',
  request_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  before_json jsonb,
  after_json jsonb,
  reason text
);

CREATE INDEX audit_events_entity_idx ON audit_events (entity_type, entity_id, created_at DESC);

CREATE INDEX audit_events_login_rate_scope_idx
  ON audit_events ((metadata_json ->> 'scope'), created_at DESC)
  WHERE action = 'LOGIN_RATE_LIMITED';

CREATE INDEX audit_events_order_case_idx
  ON audit_events ((metadata_json ->> 'billingCaseId'), created_at DESC)
  WHERE entity_type = 'ORDER';

CREATE INDEX audit_events_history_idx ON audit_events (created_at DESC, id DESC);

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

CREATE INDEX customers_name_idx ON customers (lower(display_name));
CREATE INDEX customers_email_idx ON customers (lower(email)) WHERE email IS NOT NULL;

CREATE TABLE customer_source_records (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id bigint NOT NULL REFERENCES customers(id),
  provider text NOT NULL CHECK (provider IN ('SHOPIFY', 'EBAY')),
  external_customer_id text NOT NULL,
  raw_snapshot_json jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, external_customer_id)
);

-- Il destinatario vive nello snapshot della preparazione: è quello il valore correggibile
-- prima dell'approvazione, mentre gli ordini conservano l'anagrafica importata.
CREATE TABLE billing_cases (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id bigint NOT NULL REFERENCES customers(id),
  local_order_date date NOT NULL,
  currency text NOT NULL CHECK (currency = 'EUR'),
  status text NOT NULL CHECK (status IN ('DRAFT', 'NEEDS_REVIEW', 'READY', 'DO_NOT_TRANSMIT', 'APPROVED', 'CLOSED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  customer_snapshot_json jsonb NOT NULL,
  do_not_transmit_reason text,
  public_number text GENERATED ALWAYS AS (
    repeat('0', greatest(6 - length(id::text), 0)) || id::text
  ) STORED UNIQUE,
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  customer_corrected_at timestamptz
);

-- Una sola preparazione aperta per cliente, giorno e valuta: è questo indice a impedire
-- che una separazione o una riattivazione ne inventi una seconda.
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
  trigger_status text NOT NULL CONSTRAINT orders_trigger_status_check CHECK (
    trigger_status IN (
      'WAITING_FOR_TRIGGER',
      'ELIGIBLE',
      'GROUPED',
      'CANCELLED_NO_DOCUMENT',
      'REFUNDED_BEFORE_ISSUE',
      'INVOICED',
      'NEEDS_REVIEW'
    )
  ),
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
  UNIQUE (order_id, external_line_id),
  CONSTRAINT order_lines_discount_not_above_gross CHECK (discount_amount <= gross_amount)
);

CREATE TABLE order_tax_identifiers (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id bigint NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  type text NOT NULL CONSTRAINT order_tax_identifiers_type_check
    CHECK (type IN ('CODICE_FISCALE', 'PARTITA_IVA', 'ALTRO')),
  raw_value text NOT NULL,
  normalized_value text NOT NULL,
  source_field text NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  country_code text CHECK (country_code ~ '^[A-Z]{2}$')
);

-- Due identificativi dello stesso tipo si distinguono anche per paese: senza `coalesce`
-- un identificativo senza paese renderebbe l'indice cieco al duplicato.
CREATE UNIQUE INDEX order_tax_identifiers_identity_idx
  ON order_tax_identifiers (order_id, type, coalesce(country_code, ''), normalized_value);

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

CREATE TABLE order_source_revisions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id bigint NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  billing_case_id bigint NOT NULL REFERENCES billing_cases(id),
  previous_normalized_snapshot_json jsonb NOT NULL,
  current_normalized_snapshot_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX order_source_revisions_case_idx
  ON order_source_revisions (billing_case_id, created_at DESC);
