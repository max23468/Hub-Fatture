import type pg from "pg";

export async function deleteOrphanedCustomers(
  client: pg.PoolClient,
  customerIds: Array<string | undefined>,
) {
  const ids = [...new Set(customerIds.filter((id) => id !== undefined))];
  if (!ids.length) return;
  await client.query(
    `DELETE FROM customers
     WHERE id = ANY($1::bigint[])
       AND NOT EXISTS (SELECT 1 FROM orders WHERE orders.customer_id = customers.id)
       AND NOT EXISTS (
         SELECT 1 FROM billing_cases WHERE billing_cases.customer_id = customers.id
       )
       AND NOT EXISTS (
         SELECT 1 FROM customer_source_records
         WHERE customer_source_records.customer_id = customers.id
       )`,
    [ids],
  );
}
