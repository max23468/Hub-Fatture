/** Predicati di ricerca dell’archivio mantenuti separati dalla query di elenco e ordinamento. */
export const documentArchiveSearchSql = `
  OR EXISTS (
    SELECT 1
    FROM billing_cases AS search_case
    JOIN customers AS search_customer ON search_customer.id = search_case.customer_id
    WHERE search_case.id = document_rows.billing_case_id
      AND (
        coalesce(search_case.customer_snapshot_json ->> 'email', '') ILIKE $1 ESCAPE '\\'
        OR coalesce(search_case.customer_snapshot_json ->> 'phone', '') ILIKE $1 ESCAPE '\\'
        OR search_customer.email ILIKE $1 ESCAPE '\\'
        OR search_customer.phone ILIKE $1 ESCAPE '\\'
        OR search_customer.tax_id_normalized ILIKE $1 ESCAPE '\\'
        OR EXISTS (
          SELECT 1
          FROM jsonb_array_elements(
            CASE
              WHEN jsonb_typeof(search_case.customer_snapshot_json -> 'taxIdentifiers') = 'array'
                THEN search_case.customer_snapshot_json -> 'taxIdentifiers'
              ELSE '[]'::jsonb
            END
          ) AS identifier
          WHERE coalesce(identifier ->> 'normalizedValue', identifier ->> 'value', '')
            ILIKE $1 ESCAPE '\\'
        )
      )
  )
  OR EXISTS (
    SELECT 1
    FROM document_orders
    JOIN orders ON orders.id = document_orders.order_id
    WHERE document_orders.document_id = document_rows.id
      AND (orders.display_number ILIKE $1 ESCAPE '\\'
        OR orders.external_order_id ILIKE $1 ESCAPE '\\')
  )`;
