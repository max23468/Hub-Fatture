export const documentRowsSql = `
  SELECT documents.id, documents.billing_case_id, billing_cases.public_number,
         documents.source_billing_case_id,
         source_billing_cases.public_number AS source_public_number,
         documents.kind, documents.origin, documents.status,
         documents.series, documents.fiscal_year, documents.fiscal_number,
         documents.document_date::text, documents.total_amount, documents.xml_sha256,
         billing_cases.customer_snapshot_json ->> 'displayName' AS customer_name,
         upper(billing_cases.customer_snapshot_json ->> 'countryCode') AS recipient_country,
         upper(regexp_replace(concat_ws('',
           billing_cases.customer_snapshot_json ->> 'vatNumber',
           billing_cases.customer_snapshot_json ->> 'fiscalCode'), '[^A-Za-z0-9]', '', 'g'))
           AS recipient_tax_identity,
         aruba_current.id AS aruba_batch_id, aruba_current.status AS aruba_status,
         aruba_current.provider_filename, aruba_current.provider_sdi_id,
         aruba_current.remote_updated_at, aruba_current.remote_status_changed_at,
         aruba_current.aruba_error_code, aruba_current.aruba_timeline,
         (SELECT email_deliveries.status
          FROM email_deliveries
          WHERE email_deliveries.document_id = documents.id
          ORDER BY email_deliveries.created_at DESC, email_deliveries.id DESC
          LIMIT 1) AS email_status,
         (SELECT document_orders.order_id::text FROM document_orders
          WHERE document_orders.document_id = documents.id LIMIT 1) AS historical_order_id
  FROM documents
  JOIN billing_cases ON billing_cases.id = documents.billing_case_id
  LEFT JOIN billing_cases AS source_billing_cases
    ON source_billing_cases.id = documents.source_billing_case_id
  LEFT JOIN LATERAL (
    SELECT aruba_batches.id, coalesce(submissions.status, aruba_batches.status) AS status,
           submissions.provider_filename, submissions.provider_sdi_id,
           submissions.last_checked_at::text AS remote_updated_at,
           submissions.remote_status_changed_at::text AS remote_status_changed_at,
           submissions.error_code AS aruba_error_code,
           coalesce((
             SELECT jsonb_agg(jsonb_build_object(
               'event_key', timeline.event_key,
               'status', timeline.status,
               'detail', timeline.detail,
               'observed_at', timeline.observed_at,
               'source', timeline.source
             ) ORDER BY timeline.observed_at, timeline.sequence)
             FROM (
               SELECT concat('submission:', submissions.id, ':accepted') AS event_key,
                      'ARUBA_ACCEPTED'::text AS status,
                      'File accettato da Aruba'::text AS detail,
                      submissions.accepted_at AS observed_at, 10 AS sequence,
                      'ARUBA'::text AS source
               WHERE submissions.accepted_at IS NOT NULL
               UNION ALL
               SELECT concat('submission:', submissions.id, ':submitted'),
                      'SUBMITTED', 'Documento inoltrato a SdI',
                      submissions.submitted_at, 20, 'ARUBA'
               WHERE submissions.submitted_at IS NOT NULL
               UNION ALL
               SELECT concat('notification:', notifications.id),
                      notifications.status, notifications.type,
                      notifications.received_at, 30, 'SDI'
               FROM sdi_notifications AS notifications
               WHERE notifications.submission_id = submissions.id
               UNION ALL
               SELECT concat('submission:', submissions.id, ':current'),
                      submissions.status, submissions.error_message_sanitized,
                      submissions.remote_status_changed_at, 40, 'ARUBA'
               WHERE submissions.remote_status_changed_at IS NOT NULL
                 AND submissions.status NOT IN ('ARUBA_ACCEPTED', 'SUBMITTED')
                 AND NOT EXISTS (
                   SELECT 1 FROM sdi_notifications AS matching_notification
                   WHERE matching_notification.submission_id = submissions.id
                     AND matching_notification.status = submissions.status
                 )
             ) AS timeline
           ), '[]'::jsonb) AS aruba_timeline
    FROM aruba_batch_documents
    JOIN aruba_batches ON aruba_batches.id = aruba_batch_documents.batch_id
    LEFT JOIN aruba_submissions submissions
      ON submissions.batch_id = aruba_batches.id
     AND submissions.document_id = aruba_batch_documents.document_id
    WHERE aruba_batch_documents.document_id = documents.id
    ORDER BY aruba_batches.created_at DESC LIMIT 1
  ) AS aruba_current ON true`;
