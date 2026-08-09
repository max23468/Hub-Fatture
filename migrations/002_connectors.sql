ALTER TABLE orders DROP CONSTRAINT orders_trigger_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_trigger_status_check CHECK (
  trigger_status IN (
    'WAITING_FOR_TRIGGER',
    'ELIGIBLE',
    'GROUPED',
    'CANCELLED_NO_DOCUMENT',
    'REFUNDED_BEFORE_ISSUE',
    'INVOICED',
    'NEEDS_REVIEW',
    'LEGACY_BILLING_REVIEW'
  )
);

CREATE TABLE connections (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider text NOT NULL CHECK (provider IN ('SHOPIFY', 'EBAY')),
  environment text NOT NULL CHECK (environment IN ('DEVELOPMENT', 'SANDBOX', 'PRODUCTION')),
  account_reference text NOT NULL,
  encrypted_credentials text NOT NULL,
  status text NOT NULL CHECK (status IN ('CONNECTED', 'REAUTH_REQUIRED', 'REVOKED', 'ERROR')),
  last_checked_at timestamptz,
  last_synced_at timestamptz,
  last_error_code text,
  last_error_message_sanitized text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, environment)
);

CREATE TABLE sync_cursors (
  provider text NOT NULL CHECK (provider IN ('SHOPIFY', 'EBAY')),
  stream text NOT NULL,
  cursor text,
  overlap_from timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, stream)
);

CREATE TABLE webhook_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider text NOT NULL CHECK (provider IN ('SHOPIFY', 'EBAY')),
  external_event_id text NOT NULL,
  topic text NOT NULL,
  payload_sha256 text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  lease_expires_at timestamptz,
  processed_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  status text NOT NULL DEFAULT 'PROCESSING'
    CHECK (status IN ('PROCESSING', 'PROCESSED', 'FAILED')),
  error_code text,
  UNIQUE (provider, external_event_id)
);

CREATE INDEX webhook_events_claim_idx
  ON webhook_events (status, lease_expires_at, received_at);

CREATE TABLE jobs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  type text NOT NULL CHECK (type IN ('shopify_sync_orders', 'shopify_process_webhook', 'ebay_sync_orders')),
  payload_json jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED')),
  run_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  locked_at timestamptz,
  lease_expires_at timestamptz,
  locked_by text,
  completed_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX jobs_claim_idx ON jobs (status, run_at, lease_expires_at, id);

CREATE UNIQUE INDEX jobs_scheduled_sync_idx
  ON jobs (type)
  WHERE type IN ('shopify_sync_orders', 'ebay_sync_orders')
    AND status IN ('PENDING', 'RUNNING');

CREATE TABLE refunds (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider text NOT NULL CHECK (provider IN ('SHOPIFY', 'EBAY')),
  external_account_id text NOT NULL,
  external_order_id text NOT NULL,
  external_refund_id text NOT NULL,
  order_id bigint NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('PENDING', 'COMPLETED', 'FAILED', 'AMBIGUOUS')),
  amount integer CHECK (amount IS NULL OR amount >= 0),
  completed_at timestamptz,
  raw_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, external_account_id, external_order_id, external_refund_id),
  CHECK (status = 'AMBIGUOUS' OR amount IS NOT NULL)
);

CREATE INDEX refunds_order_idx ON refunds (order_id, created_at DESC);
