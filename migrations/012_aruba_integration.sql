INSERT INTO settings (key, value_json)
VALUES
  ('aruba_mode', '"ASSISTED"'::jsonb),
  ('aruba_auth_protection', '"UNKNOWN"'::jsonb)
ON CONFLICT (key) DO NOTHING;

ALTER TABLE connections
  DROP CONSTRAINT connections_provider_check,
  ADD CONSTRAINT connections_provider_check CHECK (provider IN ('SHOPIFY', 'EBAY', 'ARUBA')),
  ALTER COLUMN encrypted_credentials DROP NOT NULL,
  ADD CONSTRAINT connections_aruba_credentials_check CHECK (
    (provider = 'ARUBA' AND encrypted_credentials IS NULL)
    OR (provider <> 'ARUBA' AND encrypted_credentials IS NOT NULL)
  );

ALTER TABLE storage_objects
  DROP CONSTRAINT storage_objects_kind_check,
  DROP CONSTRAINT storage_objects_content_type_check,
  ADD CONSTRAINT storage_objects_kind_check CHECK (kind IN (
    'INVOICE_XML', 'CREDIT_NOTE_XML', 'ARUBA_XML', 'ARUBA_P7M', 'ARUBA_PDF',
    'SDI_NOTIFICATION'
  )),
  ADD CONSTRAINT storage_objects_content_type_check CHECK (content_type IN (
    'application/xml', 'application/pkcs7-mime', 'application/pdf'
  ));

CREATE TABLE aruba_batches (
  id uuid PRIMARY KEY,
  environment text NOT NULL CHECK (environment IN ('MOCK', 'PRODUCTION')),
  mode text NOT NULL CHECK (mode IN ('ASSISTED', 'AUTOMATIC')),
  account_reference text NOT NULL CHECK (length(account_reference) BETWEEN 1 AND 200),
  manifest_sha256 text NOT NULL UNIQUE CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  document_count integer NOT NULL CHECK (document_count > 0 AND document_count <= 300),
  attempt_number integer NOT NULL DEFAULT 1 CHECK (attempt_number > 0),
  status text NOT NULL DEFAULT 'PREPARED' CHECK (status IN (
    'PREPARED', 'HELPER_ACTIVE', 'VALIDATION_FAILED', 'READY_ASSISTED',
    'PERMIT_CONSUMED', 'SUBMITTED', 'RECONCILIATION_REQUIRED', 'RECONCILED', 'CANCELLED'
  )),
  requires_reconciliation boolean NOT NULL DEFAULT false,
  created_by smallint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_readback_at timestamptz,
  CONSTRAINT aruba_batches_reconciliation_check CHECK (
    requires_reconciliation = (status = 'RECONCILIATION_REQUIRED')
  )
);

CREATE TABLE aruba_batch_documents (
  batch_id uuid NOT NULL REFERENCES aruba_batches(id) ON DELETE CASCADE,
  document_id bigint NOT NULL REFERENCES documents(id),
  position smallint NOT NULL CHECK (position > 0),
  document_revision integer NOT NULL CHECK (document_revision > 0),
  xml_sha256 text NOT NULL CHECK (xml_sha256 ~ '^[0-9a-f]{64}$'),
  filename text NOT NULL CHECK (filename ~ '^[A-Za-z0-9._-]+\.xml$'),
  PRIMARY KEY (batch_id, document_id),
  UNIQUE (batch_id, position)
);

CREATE INDEX aruba_batch_documents_document_idx
  ON aruba_batch_documents (document_id, batch_id);

CREATE FUNCTION reject_aruba_manifest_changes() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Il manifest Aruba è immutabile';
END;
$$;

CREATE TRIGGER aruba_batch_documents_immutable
  BEFORE UPDATE OR DELETE ON aruba_batch_documents
  FOR EACH ROW EXECUTE FUNCTION reject_aruba_manifest_changes();

CREATE TABLE aruba_helper_tokens (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  batch_id uuid NOT NULL REFERENCES aruba_batches(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX aruba_helper_tokens_batch_idx
  ON aruba_helper_tokens (batch_id, expires_at DESC);

CREATE TABLE aruba_send_permits (
  id uuid PRIMARY KEY,
  batch_id uuid NOT NULL UNIQUE REFERENCES aruba_batches(id) ON DELETE CASCADE,
  manifest_sha256 text NOT NULL CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  document_count integer NOT NULL CHECK (document_count > 0 AND document_count <= 300),
  mode text NOT NULL CHECK (mode = 'AUTOMATIC'),
  scope text NOT NULL DEFAULT 'ORDINARY' CHECK (scope IN ('CANARY', 'ORDINARY')),
  authorized_by smallint NOT NULL REFERENCES users(id),
  authorized_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);

CREATE TABLE aruba_submissions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_id uuid NOT NULL REFERENCES aruba_batches(id) ON DELETE CASCADE,
  document_id bigint NOT NULL REFERENCES documents(id),
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  environment text NOT NULL CHECK (environment IN ('MOCK', 'PRODUCTION')),
  mode text NOT NULL CHECK (mode IN ('ASSISTED', 'AUTOMATIC')),
  manifest_sha256 text NOT NULL CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  xml_sha256 text NOT NULL CHECK (xml_sha256 ~ '^[0-9a-f]{64}$'),
  remote_id text,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN (
    'PENDING', 'UPLOADED', 'VALIDATED', 'VALIDATION_FAILED', 'READY_TO_SEND',
    'SUBMITTED', 'SDI_PROCESSING', 'DELIVERED', 'NOT_DELIVERED', 'REJECTED', 'UNKNOWN', 'REMOVED',
    'RECONCILED'
  )),
  helper_version text,
  browser_name text,
  validation_metadata_json jsonb NOT NULL DEFAULT '{}',
  readback_metadata_json jsonb NOT NULL DEFAULT '{}',
  submitted_at timestamptz,
  last_checked_at timestamptz,
  error_code text,
  error_message_sanitized text,
  UNIQUE (batch_id, document_id, attempt_number)
);

CREATE INDEX aruba_submissions_attention_idx
  ON aruba_submissions (status, last_checked_at)
  WHERE status IN ('VALIDATION_FAILED', 'UNKNOWN', 'REJECTED');

CREATE TABLE aruba_files (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id bigint NOT NULL REFERENCES documents(id),
  submission_id bigint REFERENCES aruba_submissions(id),
  storage_object_id bigint NOT NULL UNIQUE REFERENCES storage_objects(id),
  kind text NOT NULL CHECK (kind IN ('ARUBA_XML', 'ARUBA_P7M', 'ARUBA_PDF', 'SDI_NOTIFICATION')),
  imported_at timestamptz NOT NULL DEFAULT now(),
  metadata_json jsonb NOT NULL DEFAULT '{}'
);

CREATE TABLE sdi_notifications (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  submission_id bigint NOT NULL REFERENCES aruba_submissions(id),
  remote_notification_id text,
  type text NOT NULL,
  status text NOT NULL CHECK (status IN ('SDI_PROCESSING', 'DELIVERED', 'NOT_DELIVERED', 'REJECTED')),
  received_at timestamptz NOT NULL DEFAULT now(),
  storage_object_id bigint NOT NULL UNIQUE REFERENCES storage_objects(id),
  metadata_json jsonb NOT NULL DEFAULT '{}',
  UNIQUE (submission_id, remote_notification_id)
);
