ALTER TABLE users
  ADD COLUMN can_approve boolean NOT NULL DEFAULT false;

UPDATE users SET can_approve = (username = 'matteo');

ALTER TABLE users
  ADD CONSTRAINT users_approval_identity_check
  CHECK (can_approve = (username = 'matteo'));

CREATE TABLE fiscal_profiles (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  version integer NOT NULL UNIQUE CHECK (version > 0),
  status text NOT NULL CHECK (status IN ('MOCK', 'AUDITED', 'RETIRED')),
  profile_json jsonb NOT NULL,
  source_xml_sha256 text CHECK (source_xml_sha256 ~ '^[0-9a-f]{64}$'),
  audited_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fiscal_profiles_audit_check CHECK (
    (status = 'AUDITED' AND source_xml_sha256 IS NOT NULL AND audited_at IS NOT NULL)
    OR status <> 'AUDITED'
  )
);

CREATE UNIQUE INDEX fiscal_profiles_one_active_idx
  ON fiscal_profiles ((true))
  WHERE status IN ('MOCK', 'AUDITED');

ALTER TABLE billing_cases
  ADD COLUMN fiscal_profile_version integer REFERENCES fiscal_profiles(version);

CREATE TABLE storage_objects (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('INVOICE_XML', 'CREDIT_NOTE_XML')),
  relative_path text NOT NULL UNIQUE CHECK (
    relative_path <> ''
    AND relative_path !~ '(^|/)\.\.(/|$)'
    AND relative_path !~ '^/'
  ),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes integer NOT NULL CHECK (size_bytes > 0),
  content_type text NOT NULL CHECK (content_type = 'application/xml'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE documents (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  billing_case_id bigint NOT NULL REFERENCES billing_cases(id),
  kind text NOT NULL CHECK (kind IN ('INVOICE', 'CREDIT_NOTE')),
  status text NOT NULL CHECK (status IN ('DRAFT', 'APPROVED')),
  document_type text NOT NULL CHECK (document_type IN ('TD01', 'TD04')),
  series text NOT NULL CHECK (series <> ''),
  fiscal_year integer,
  fiscal_number integer,
  document_date date NOT NULL,
  fiscal_profile_version integer NOT NULL REFERENCES fiscal_profiles(version),
  currency text NOT NULL CHECK (currency = 'EUR'),
  total_amount integer NOT NULL CHECK (total_amount >= 0),
  source_total_amount integer NOT NULL CHECK (source_total_amount >= 0),
  difference_amount integer NOT NULL,
  difference_reason text,
  draft_version integer NOT NULL DEFAULT 1 CHECK (draft_version > 0),
  projection_sha256 text NOT NULL CHECK (projection_sha256 ~ '^[0-9a-f]{64}$'),
  pending_payment_confirmed_at timestamptz,
  amount_difference_confirmed_at timestamptz,
  approved_at timestamptz,
  xml_sha256 text CHECK (xml_sha256 ~ '^[0-9a-f]{64}$'),
  immutable_snapshot_json jsonb,
  fiscal_profile_snapshot_json jsonb,
  storage_object_id bigint REFERENCES storage_objects(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, kind),
  UNIQUE (billing_case_id, kind),
  CONSTRAINT documents_numbered_state_check CHECK (
    (status = 'DRAFT'
      AND fiscal_year IS NULL AND fiscal_number IS NULL
      AND approved_at IS NULL AND xml_sha256 IS NULL AND immutable_snapshot_json IS NULL
      AND fiscal_profile_snapshot_json IS NULL AND storage_object_id IS NULL)
    OR
    (status = 'APPROVED'
      AND fiscal_year IS NOT NULL AND fiscal_number IS NOT NULL AND document_date IS NOT NULL
      AND approved_at IS NOT NULL AND xml_sha256 IS NOT NULL AND immutable_snapshot_json IS NOT NULL
      AND fiscal_profile_snapshot_json IS NOT NULL AND storage_object_id IS NOT NULL)
  ),
  CONSTRAINT documents_difference_reason_check CHECK (
    difference_amount = 0 OR nullif(btrim(difference_reason), '') IS NOT NULL
  )
);

CREATE UNIQUE INDEX documents_fiscal_number_idx
  ON documents (series, fiscal_year, fiscal_number)
  WHERE status = 'APPROVED';

CREATE TABLE document_orders (
  document_id bigint NOT NULL,
  document_kind text NOT NULL CHECK (document_kind IN ('INVOICE', 'CREDIT_NOTE')),
  order_id bigint NOT NULL REFERENCES orders(id),
  amount integer NOT NULL CHECK (amount >= 0),
  PRIMARY KEY (document_id, order_id),
  FOREIGN KEY (document_id, document_kind) REFERENCES documents(id, kind) ON DELETE CASCADE
);

CREATE UNIQUE INDEX document_orders_one_invoice_idx
  ON document_orders (order_id)
  WHERE document_kind = 'INVOICE';

CREATE TABLE document_lines (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id bigint NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  order_id bigint REFERENCES orders(id),
  line_number integer NOT NULL CHECK (line_number > 0),
  description text NOT NULL CHECK (nullif(btrim(description), '') IS NOT NULL),
  quantity integer NOT NULL CHECK (quantity > 0),
  unit_amount integer NOT NULL CHECK (unit_amount >= 0),
  total_amount integer NOT NULL CHECK (total_amount >= 0),
  tax_nature text NOT NULL CHECK (tax_nature = 'N5'),
  UNIQUE (document_id, line_number),
  CONSTRAINT document_lines_total_check CHECK (total_amount = quantity * unit_amount)
);

CREATE FUNCTION reject_approved_document_changes() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'APPROVED' THEN
    RAISE EXCEPTION 'Un documento approvato è immutabile';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER documents_approved_immutable
  BEFORE UPDATE OR DELETE ON documents
  FOR EACH ROW EXECUTE FUNCTION reject_approved_document_changes();

CREATE FUNCTION reject_approved_document_children_changes() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM documents
    WHERE id = coalesce(OLD.document_id, NEW.document_id) AND status = 'APPROVED'
  ) THEN
    RAISE EXCEPTION 'Le righe di un documento approvato sono immutabili';
  END IF;
  RETURN coalesce(NEW, OLD);
END;
$$;

CREATE TRIGGER document_orders_approved_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON document_orders
  FOR EACH ROW EXECUTE FUNCTION reject_approved_document_children_changes();

CREATE TRIGGER document_lines_approved_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON document_lines
  FOR EACH ROW EXECUTE FUNCTION reject_approved_document_children_changes();
