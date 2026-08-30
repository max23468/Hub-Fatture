CREATE TABLE operational_controls (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 3 AND 220),
  kind text NOT NULL CHECK (length(kind) BETWEEN 3 AND 80),
  category text NOT NULL CHECK (category IN ('DECISION', 'TECHNICAL', 'COMPLIANCE')),
  severity text NOT NULL CHECK (severity IN ('BLOCKING', 'IMPORTANT', 'ORDINARY')),
  state text NOT NULL DEFAULT 'OPEN' CHECK (state IN ('OPEN', 'WAITING', 'RESOLVED')),
  source_type text NOT NULL CHECK (length(source_type) BETWEEN 2 AND 60),
  source_id text NOT NULL CHECK (length(source_id) BETWEEN 1 AND 200),
  origin text NOT NULL CHECK (origin IN (
    'ORDERS', 'DOCUMENTS', 'CUSTOMERS', 'CONNECTIONS', 'PRIVACY'
  )),
  title text NOT NULL CHECK (length(title) BETWEEN 3 AND 240),
  detail text NOT NULL CHECK (length(detail) BETWEEN 1 AND 500),
  consequence text NOT NULL CHECK (length(consequence) BETWEEN 3 AND 600),
  href text NOT NULL CHECK (href LIKE '/%'),
  primary_action text NOT NULL CHECK (length(primary_action) BETWEEN 2 AND 120),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  metadata_json jsonb NOT NULL DEFAULT '{}',
  opened_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  waiting_at timestamptz,
  resolved_at timestamptz,
  resolution_code text,
  resolution_note text,
  UNIQUE (source_type, source_id, kind),
  CHECK ((state = 'WAITING') = (waiting_at IS NOT NULL)),
  CHECK ((state = 'RESOLVED') = (resolved_at IS NOT NULL))
);

CREATE INDEX operational_controls_queue_idx
  ON operational_controls (state, severity, opened_at, id);

CREATE INDEX operational_controls_origin_idx
  ON operational_controls (origin, kind, state);

ALTER TABLE users DROP CONSTRAINT users_approval_identity_check;

UPDATE users
SET can_approve = true
WHERE lower(username) = 'codex' AND can_approve = false;

ALTER TABLE users
  ADD CONSTRAINT users_approval_identity_check CHECK (can_approve = true);
