# Evidenza locale note di credito ed e-mail

## Capacità verificate

- rimborso totale/parziale, pending e ambiguo prima dell’emissione;
- TD04 cumulativa e nuova bozza dopo la prima TD04 approvata;
- rifiuto di fattura scartata o non emessa, doppio rimborso e superamento del residuo;
- concorrenza PostgreSQL e rollback completo quando l’audit critico fallisce;
- TD04 con fattura collegata, validazione XSD, numerazione, comparatore, approvazione e batch Aruba comune;
- mapping Shopify e blocco prudenziale del rimborso eBay ambiguo;
- trigger e-mail soltanto su `DELIVERED` e `NOT_DELIVERED` con PDF ufficiale;
- trasporto SMTP sintetico Nodemailer, TLS obbligatorio sui trasporti reali, mittente approvato immutabile, errore sanificato, retry, crash incerto e prevenzione del doppio invio;
- E2E sintetico da rimborso a TD04, helper assistito, readback, PDF e invio JSON controllato.

Le prove eseguibili vivono in `src/refunds.test.ts`, `src/email.test.ts`, `src/documents.test.ts`, `src/db/refunds.server.test.ts`, `src/db/documents.server.test.ts`, `src/db/migrations.server.test.ts`, `src/integrations/connectors.test.ts` e `tests/e2e/readiness.spec.ts`.

I controlli canonici applicabili, eseguiti separatamente con PostgreSQL di prova reale, sono verdi: policy toolchain, formato, lint, typecheck, build server, migrazioni pulite e aggiornamento rappresentativo, test Node/PostgreSQL, smoke import e type stripping, React Doctor, build applicativa ed E2E Playwright. Su richiesta del titolare non è stato eseguito lo scan delle dipendenze e non viene quindi dichiarato come evidenza di questa sessione.

## Gate esterno ancora aperto

Il codice e le prove locali non chiudono HF-O07. Il controllo DNS è confermato, ma il PoC OCI reale non è stato eseguito: nessuna risorsa OCI, modifica DNS, credenziale o e-mail è stata richiesta o usata. La checklist e il preflight sono in [PoC OCI Email Delivery](../runbooks/oci-email-delivery-poc.md).

La milestone corrente resta quindi **in corso** fino alla scelta del trasporto canonico basata sull’evidenza richiesta dalla decisione rinviata. La qualifica TD04 sul pannello Aruba reale resta un gate di collaudo successivo e separato: nessun accesso o invio Aruba reale è compreso in questa evidenza.
