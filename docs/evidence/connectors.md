# Contratti connettori

## Shopify

- Admin GraphQL API: `2026-07`, senza alias runtime `latest`.
- Finestra di supporto registrata: fino al 16 luglio 2027; verifica almeno trimestrale e prima di ogni release.
- Scope: `read_orders`, `read_customers`; il secondo serve al fallback `Customer.taxSettings.taxId` ed è soggetto ai protected customer data.
- Query e mapper: `src/integrations/shopify.server.ts`.
- Contract check: `npm test -- src/integrations/connectors.test.ts`.

Le fixture versionate sono sintetiche e anonimizzate. Il readback Development su SyncBay Dev ha confermato la forma reale dei campi italiani: `TAX_CREDENTIAL_IT` e `TAX_EMAIL_IT`, entrambi con `purpose: TAX` e `countryCode: IT`. Il mapper usa il primo come codice fiscale e ignora il secondo, che contiene la PEC e non è un identificativo fiscale. Nessun valore personale è stato copiato; la fixture conserva soltanto la forma osservata con dati sintetici. HF-O04 è chiuso.

## eBay

- API: Sell Fulfillment `v1`; schema documentato `1.20.7`.
- Endpoint Production: `https://api.ebay.com/sell/fulfillment/v1`; Sandbox: `https://api.sandbox.ebay.com/sell/fulfillment/v1`.
- Scope: `sell.fulfillment.readonly`; `getOrders` incrementale seguito da `getOrder` per `buyer.taxIdentifier`.
- `legacyOrderId` non è usato: è stato dismesso il 10 aprile 2025.
- Gli importi `paymentSummary.refunds.amount` sono netti venditore e possono escludere le imposte eBay: il mapper li conserva nel raw ma imposta il rimborso `AMBIGUOUS` senza inventare l'importo cliente.
- Il keyset riusato è `botCF`. FiscalBay espone l'endpoint canonico Marketplace Account Deletion, verifica la firma e inoltra a Hub Fatture gli stessi byte e la firma originale; Hub Fatture verifica di nuovo e cancella soltanto i dati del compratore non fiscalizzati. Il tenant venditore FiscalBay non viene eliminato.
- Contract check: `npm test -- src/integrations/connectors.test.ts`.

Le fixture versionate sono sintetiche e anonimizzate. Il readback Production tramite il keyset `botCF` e i token tenant già custoditi da FiscalBay ha confermato `buyer.taxIdentifier` con tipo `CODICE_FISCALE` e due forme di `paymentSummary.refunds`: entrambe espongono `refundReferenceId` e `amount.value`/`amount.currency`, mentre `refundId` è opzionale. Nessun identificativo, importo o dato personale reale è stato copiato. La fixture e il mapper coprono entrambe le forme e mantengono l'importo cliente `AMBIGUOUS`; HF-O05 è chiuso.
