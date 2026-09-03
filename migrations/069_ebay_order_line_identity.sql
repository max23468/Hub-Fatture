CREATE TABLE order_source_identities (
  provider text NOT NULL CHECK (provider IN ('SHOPIFY', 'EBAY')),
  external_account_id text NOT NULL,
  identity_kind text NOT NULL CHECK (identity_kind = 'ORDER_LINE_ITEM'),
  external_id text NOT NULL,
  order_id bigint NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, external_account_id, identity_kind, external_id)
);

CREATE INDEX order_source_identities_order_idx
  ON order_source_identities (order_id);

INSERT INTO order_source_identities
  (provider, external_account_id, identity_kind, external_id, order_id)
SELECT orders.provider, orders.external_account_id, 'ORDER_LINE_ITEM',
       (source_line ->> 'legacyItemId') || '-' || (source_line ->> 'lineItemId'), orders.id
FROM orders
JOIN order_lines ON order_lines.order_id = orders.id
JOIN LATERAL jsonb_array_elements(
  coalesce(orders.raw_snapshot_json -> 'sourceSnapshot' -> 'lineItems', '[]'::jsonb)
) AS source_line
  ON source_line ->> 'lineItemId' = order_lines.external_line_id
WHERE orders.provider = 'EBAY';
