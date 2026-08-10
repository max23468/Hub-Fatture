# Contratti connettori

## Shopify

- Admin GraphQL API: `2026-07`, senza alias runtime `latest`.
- Finestra di supporto registrata: fino al 16 luglio 2027 alle 15:00 UTC; verifica almeno trimestrale e prima di ogni release sulla [tabella ufficiale Shopify](https://shopify.dev/docs/api/usage/versioning).
- Scope: `read_orders`, `read_customers`, `read_fulfillments`; il secondo serve al fallback `Customer.taxSettings.taxId` ed è soggetto ai protected customer data, il terzo ai webhook di evasione.
- Query e mapper: `src/integrations/shopify.server.ts`.
- Contract check: `npm test -- src/integrations/connectors.test.ts`.

Le fixture versionate sono sintetiche e anonimizzate. Il readback Development su SyncBay Dev ha confermato la forma reale dei campi italiani: `TAX_CREDENTIAL_IT` e `TAX_EMAIL_IT`, entrambi con `purpose: TAX` e `countryCode: IT`. Il mapper usa il primo come codice fiscale, conserva il secondo come PEC e mantiene chiave, Paese, finalità, titolo e valore nello snapshot dell'ordine. Nessun valore personale è stato copiato; la fixture conserva soltanto la forma osservata con dati sintetici.

## eBay

- API: Sell Fulfillment `v1`; schema documentato `1.20.7`.
- Endpoint Production: `https://api.ebay.com/sell/fulfillment/v1`; Sandbox: `https://api.sandbox.ebay.com/sell/fulfillment/v1`.
- Scope: `sell.fulfillment.readonly`; `getOrders` incrementale seguito da `getOrder` per `buyer.taxIdentifier`.
- `legacyOrderId` non è usato: è stato dismesso il 10 aprile 2025.
- Gli importi `paymentSummary.refunds.amount` sono netti venditore e possono escludere le imposte eBay: il mapper li conserva nel raw ma imposta il rimborso `AMBIGUOUS` senza inventare l'importo cliente.
- eBay non pubblica una data di fine supporto per Fulfillment `v1`: la finestra operativa vale 31 giorni dall'ultimo controllo riuscito delle [release note Fulfillment](https://developer.ebay.com/api-docs/sell/fulfillment/static/release-notes.html) e dello [stato deprecazioni](https://developer.ebay.com/develop/get-started/api-deprecation-status). Il controllo si ripete almeno mensilmente e prima di ogni release; una variazione riapre il contract check prima del deploy.
- Il keyset riusato è `botCF`. FiscalBay contiene il relay Marketplace Account Deletion, ma la configurazione resta deliberatamente inattiva finché Hub Fatture non dispone dell'endpoint HTTPS pubblico Production. L'attivazione richiederà readback delle tre variabili di routing e una prova firmata end-to-end. Hub Fatture verifica comunque la firma e cancella soltanto i dati del compratore non fiscalizzati; il tenant venditore FiscalBay non viene eliminato.
- Contract check: `npm test -- src/integrations/connectors.test.ts`.

Le fixture versionate sono sintetiche e anonimizzate. Il readback Production tramite il keyset `botCF` e i token tenant già custoditi da FiscalBay ha confermato `buyer.taxIdentifier` con tipo `CODICE_FISCALE` e due forme di `paymentSummary.refunds`: entrambe espongono `refundReferenceId` e `amount.value`/`amount.currency`, mentre `refundId` è opzionale. Nessun identificativo, importo o dato personale reale è stato copiato. La fixture e il mapper coprono entrambe le forme e mantengono l'importo cliente `AMBIGUOUS`.

## Invarianti di sicurezza

- I webhook Shopify sono associati al negozio configurato; l'identità persistita deriva dall'hash del corpo firmato, la forma del payload distingue i topic privacy e topic e payload non possono cambiare durante un replay.
- Disinstallazione e richieste privacy verificano anche il dominio firmato nel corpo. La disinstallazione revoca la connessione e chiude l'evento nella stessa transazione; il payload delle richieste dati viene eliminato dopo l'elaborazione.
- Import, cursore e stato dei job sono recintati dalla stessa identità di lease; l'import mantiene il lock e rinnova la lease prima del commit, così un worker scaduto non può confermare il lavoro di un successore.
- L'endpoint pubblico eBay limita le richieste prima del recupero delle chiavi; cache positiva, cache negativa, concorrenza e budget globale per finestra hanno limiti espliciti.
- Le chiamate HTTP ai provider rifiutano i redirect, così credenziali e token non vengono inoltrati verso destinazioni non validate.

## Ricevute di validazione

### Mapping fiscale Shopify

- Target osservato: store Development `SyncBay Dev`, app dedicata Hub Fatture, Admin GraphQL `2026-07`.
- Operazione: lettura della forma dei campi localizzati di un ordine; nessuna mutazione remota.
- Risultato sanitizzato: presenti `TAX_CREDENTIAL_IT` e `TAX_EMAIL_IT` con metadati stabili; fixture sintetica in `tests/fixtures/connectors/shopify-orders.json`.
- Prova ripetibile: `npm test -- src/integrations/connectors.test.ts` verifica codice fiscale, PEC, titolo, e-mail ordine, indirizzo di spedizione e snapshot.
- Commit implementazione: `201276f`.

### Mapping fiscale eBay

- Target osservato: account venditore `botCF`, Fulfillment Production in sola lettura tramite credenziali già custodite da FiscalBay.
- Operazione: readback della sola forma di `buyer.taxIdentifier` e dei rimborsi; nessuna mutazione remota.
- Risultato sanitizzato: tipo fiscale dichiarato e due varianti del riferimento rimborso; fixture sintetica in `tests/fixtures/connectors/ebay-orders.json`.
- Prova ripetibile: `npm test -- src/integrations/connectors.test.ts` verifica tipo dichiarato, rimborso ambiguo, spedizione, snapshot e vincolo dell'host di paginazione.
- Commit implementazione: `201276f`.

## Chiusura della milestone

- Baseline applicativa verificata: `7d69056`, comprensiva della chiusura end-to-end dei connettori e della correzione condivisa che ricostruisce sempre l'immagine Development; schema applicato fino a `004_connector_operations.sql`.
- Readback Shopify: app dedicata Hub Fatture installata su `SyncBay Dev`; versione `hub-fatture-2` attiva con Admin GraphQL e webhook `2026-07` e scope `read_customers`, `read_fulfillments`, `read_orders`.
- Readback eBay: keyset `botCF` riusato, mapping fiscale e rimborsi verificati in sola lettura; il relay Production resta inattivo finché non esiste un endpoint HTTPS stabile, senza bloccare lo sviluppo sintetico previsto prima del go-live.
- Gate di chiusura osservato: `TEST_DATABASE_URL=postgres://hub_fatture:***@127.0.0.1:5433/hub_fatture_test npm run check` è terminato con esito positivo sul commit `ba9cf7e35ec2da477a2fe55a7661b5c128c9110e`; la registrazione di questa ricevuta modifica soltanto l'evidenza ed è verificata dai gate CI obbligatori sull'HEAD della PR.
- Limite Development: i Quick Tunnel sono temporanei; a tunnel chiuso una nuova prova live richiede una nuova sessione OAuth, mentre database, chiave di cifratura e stack Docker restano persistenti.
- Retry anteprima eBay: avvio ordinario e retry manuale condividono lo stesso advisory lock PostgreSQL; se esiste già un'anteprima attiva il retry restituisce un conflitto applicativo stabile e lascia invariato il job fallito. Il test PostgreSQL riproduce la sequenza avvio → retry che in precedenza poteva raggiungere il vincolo univoco.
