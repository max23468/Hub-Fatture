-- Le revisioni operative si chiudono su ordini e preparazioni. Un cambio della chiave
-- di matching poteva lasciare il vecchio profilo senza alcun collegamento, mantenendolo
-- comunque nella directory Clienti. Eliminiamo soltanto questi residui privi di storia,
-- sorgente e pratica; i profili ancora referenziati restano immutati.
DELETE FROM customers
WHERE NOT EXISTS (SELECT 1 FROM orders WHERE orders.customer_id = customers.id)
  AND NOT EXISTS (
    SELECT 1 FROM billing_cases WHERE billing_cases.customer_id = customers.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM customer_source_records
    WHERE customer_source_records.customer_id = customers.id
  );
