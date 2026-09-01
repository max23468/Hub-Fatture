CREATE TABLE customer_identity_exceptions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider text NOT NULL CHECK (provider = 'EBAY'),
  external_customer_id text NOT NULL CHECK (length(external_customer_id) BETWEEN 1 AND 200),
  source_identity_sha256 text NOT NULL CHECK (source_identity_sha256 ~ '^[0-9a-f]{64}$'),
  first_name text NOT NULL CHECK (length(btrim(first_name)) BETWEEN 1 AND 60),
  last_name text NOT NULL CHECK (length(btrim(last_name)) BETWEEN 1 AND 60),
  accepted_by smallint NOT NULL REFERENCES users(id),
  accepted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, external_customer_id)
);

CREATE INDEX customer_identity_exceptions_source_idx
  ON customer_identity_exceptions (provider, external_customer_id, source_identity_sha256);
