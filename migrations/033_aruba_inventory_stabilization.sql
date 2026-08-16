ALTER TABLE aruba_sync_sessions
  ADD COLUMN expected_streams text[] NOT NULL DEFAULT '{}',
  ADD COLUMN expected_oldest_reconciliation_date date;

CREATE FUNCTION aruba_expected_inventory_oldest_date(started_at_value timestamptz) RETURNS date
LANGUAGE sql
STABLE
AS $$
  SELECT coalesce(
    (SELECT min(local_order_date)
     FROM orders
     WHERE trigger_status NOT IN ('INVOICED', 'CANCELLED_NO_DOCUMENT', 'REFUNDED_BEFORE_ISSUE')),
    (started_at_value AT TIME ZONE 'Europe/Rome')::date
  );
$$;

CREATE FUNCTION aruba_expected_inventory_streams(
  target_environment text,
  target_account text,
  started_at_value timestamptz,
  absolute_expires_at_value timestamptz
) RETURNS text[]
LANGUAGE sql
STABLE
AS $$
  WITH bounds AS (
    SELECT
      extract(year FROM started_at_value AT TIME ZONE 'Europe/Rome')::integer AS started_year,
      extract(year FROM absolute_expires_at_value AT TIME ZONE 'Europe/Rome')::integer AS expires_year,
      extract(year FROM aruba_expected_inventory_oldest_date(started_at_value))::integer AS oldest_year
  ), baseline_years AS (
    SELECT generate_series(
      greatest(started_year, expires_year),
      greatest(
        greatest(started_year, expires_year) - 19,
        least(oldest_year, greatest(started_year, expires_year))
      ),
      -1
    )::integer AS fiscal_year
    FROM bounds
  ), required_years AS (
    SELECT fiscal_year FROM baseline_years
    UNION
    SELECT DISTINCT fiscal_year
    FROM aruba_remote_documents
    WHERE environment = target_environment
      AND account_reference = target_account
      AND remote_status IN ('SUBMITTED', 'SDI_PROCESSING', 'UNKNOWN')
  ), streams AS (
    SELECT fiscal_year, 1 AS kind_order, 'invoices:' || fiscal_year::text AS stream
    FROM required_years
    UNION ALL
    SELECT fiscal_year, 2 AS kind_order, 'credit-notes:' || fiscal_year::text AS stream
    FROM required_years
  )
  SELECT coalesce(array_agg(stream ORDER BY fiscal_year DESC, kind_order), '{}')
  FROM streams;
$$;

CREATE FUNCTION snapshot_aruba_inventory_streams() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.expected_oldest_reconciliation_date := aruba_expected_inventory_oldest_date(NEW.started_at);
  NEW.expected_streams := aruba_expected_inventory_streams(
    NEW.environment,
    NEW.account_reference,
    NEW.started_at,
    NEW.absolute_expires_at
  );
  IF cardinality(NEW.expected_streams) < 2 OR cardinality(NEW.expected_streams) > 50 THEN
    RAISE EXCEPTION 'Perimetro inventario Aruba non valido';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER aruba_sync_sessions_snapshot_streams
  BEFORE INSERT ON aruba_sync_sessions
  FOR EACH ROW EXECUTE FUNCTION snapshot_aruba_inventory_streams();

UPDATE aruba_sync_sessions
SET expected_oldest_reconciliation_date = aruba_expected_inventory_oldest_date(started_at),
    expected_streams = aruba_expected_inventory_streams(
      environment,
      account_reference,
      started_at,
      absolute_expires_at
    );

ALTER TABLE aruba_sync_sessions
  ALTER COLUMN expected_oldest_reconciliation_date SET NOT NULL,
  ADD CONSTRAINT aruba_sync_sessions_expected_streams_check CHECK (
    cardinality(expected_streams) BETWEEN 2 AND 50
  );

CREATE OR REPLACE FUNCTION reject_approved_document_children_changes() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'document_orders' AND TG_OP = 'INSERT' AND EXISTS (
    SELECT 1 FROM documents
    WHERE id = NEW.document_id AND origin = 'ARUBA_HISTORY'
  ) THEN
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'document_lines' AND TG_OP = 'INSERT' AND pg_trigger_depth() > 1 AND EXISTS (
    SELECT 1 FROM documents
    WHERE id = NEW.document_id AND origin = 'ARUBA_HISTORY'
  ) THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1 FROM documents
    WHERE status = 'APPROVED'
      AND id IN (OLD.document_id, NEW.document_id)
  ) THEN
    RAISE EXCEPTION 'Le righe di un documento approvato sono immutabili';
  END IF;
  RETURN coalesce(NEW, OLD);
END;
$$;

CREATE FUNCTION materialize_aruba_history_document_lines() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'APPROVED' AND NEW.origin = 'ARUBA_HISTORY' THEN
    INSERT INTO document_lines
      (document_id, order_id, line_number, description, quantity, unit_amount,
       total_amount, tax_nature)
    SELECT NEW.id,
           CASE
             WHEN line.value ->> 'orderId' ~ '^\d+$' THEN (line.value ->> 'orderId')::bigint
             ELSE NULL
           END,
           line.ordinality::integer,
           line.value ->> 'description',
           (line.value ->> 'quantity')::integer,
           (line.value ->> 'unitAmount')::integer,
           (line.value ->> 'quantity')::integer * (line.value ->> 'unitAmount')::integer,
           'N5'
    FROM jsonb_array_elements(coalesce(NEW.immutable_snapshot_json -> 'lines', '[]'::jsonb))
      WITH ORDINALITY AS line(value, ordinality)
    WHERE NOT EXISTS (
      SELECT 1 FROM document_lines existing WHERE existing.document_id = NEW.id
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER documents_materialize_aruba_history_lines
  AFTER INSERT OR UPDATE OF status, origin ON documents
  FOR EACH ROW EXECUTE FUNCTION materialize_aruba_history_document_lines();

ALTER TABLE document_lines DISABLE TRIGGER document_lines_approved_immutable;

INSERT INTO document_lines
  (document_id, order_id, line_number, description, quantity, unit_amount,
   total_amount, tax_nature)
SELECT documents.id,
       CASE
         WHEN line.value ->> 'orderId' ~ '^\d+$' THEN (line.value ->> 'orderId')::bigint
         ELSE NULL
       END,
       line.ordinality::integer,
       line.value ->> 'description',
       (line.value ->> 'quantity')::integer,
       (line.value ->> 'unitAmount')::integer,
       (line.value ->> 'quantity')::integer * (line.value ->> 'unitAmount')::integer,
       'N5'
FROM documents
CROSS JOIN LATERAL jsonb_array_elements(
  coalesce(documents.immutable_snapshot_json -> 'lines', '[]'::jsonb)
) WITH ORDINALITY AS line(value, ordinality)
WHERE documents.status = 'APPROVED'
  AND documents.origin = 'ARUBA_HISTORY'
  AND NOT EXISTS (
    SELECT 1 FROM document_lines existing WHERE existing.document_id = documents.id
  );

ALTER TABLE document_lines ENABLE TRIGGER document_lines_approved_immutable;
