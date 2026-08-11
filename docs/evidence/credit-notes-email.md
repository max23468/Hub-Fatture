# Evidenza locale note di credito ed e-mail

## Capacità verificate

- rimborso totale isolato in `Non trasmettere` e rimborso parziale assorbito una sola volta con importo esatto, anche dopo una modifica manuale delle righe; revoca e ritorno a pending ripristinano la bozza piena, mentre l’ambiguo resta escluso;
- TD04 cumulativa con data di bozza stabile, ricalcolo quando un rimborso cambia o scompare e nuova bozza dopo la prima TD04 approvata;
- rifiuto di fattura scartata o non emessa, doppio rimborso e superamento del residuo;
- concorrenza PostgreSQL e rollback completo quando l’audit critico fallisce;
- TD04 con fattura collegata, validazione XSD, numerazione, comparatore, approvazione e batch Aruba comune;
- mapping Shopify e blocco prudenziale del rimborso eBay ambiguo;
- trigger e-mail soltanto su `DELIVERED` e `NOT_DELIVERED` con PDF ufficiale;
- trasporto SMTP sintetico Nodemailer, TLS obbligatorio sui trasporti reali, mittente approvato immutabile, retry limitato agli errori temporanei, errore sanificato, crash incerto e prevenzione del doppio invio;
- riavvio manuale limitato alle sole sincronizzazioni Shopify/eBay mostrate in Attività: rimborsi e invii e-mail conservano i propri controlli dedicati;
- messaggi operativi leggibili, senza tipi di job o codici d’errore interni esposti al negoziante;
- E2E sintetico da rimborso a TD04, helper assistito, readback, PDF e invio JSON controllato.

Le prove eseguibili vivono in `src/refunds.test.ts`, `src/email.test.ts`, `src/documents.test.ts`, `src/db/refunds.server.test.ts`, `src/db/documents.server.test.ts`, `src/db/migrations.server.test.ts`, `src/integrations/connectors.test.ts` e `tests/e2e/readiness.spec.ts`.

I controlli canonici applicabili, eseguiti separatamente con PostgreSQL di prova reale, sono verdi: policy toolchain, formato, lint, typecheck, build server, migrazioni pulite e aggiornamento rappresentativo, test Node/PostgreSQL, smoke import e type stripping, React Doctor, build applicativa ed E2E Playwright. Su richiesta del titolare non è stato eseguito lo scan delle dipendenze e non viene quindi dichiarato come evidenza di questa sessione.

## Trasporto esterno verificato

Nella regione di Milano sono stati verificati dominio OCI, DKIM, mittente approvato e SPF pubblico. Compose passa la stessa configurazione SMTP ad app e worker e conserva il trasporto sintetico come protezione predefinita. La credenziale dedicata resta nel file locale ignorato da Git con permessi riservati al titolare. Il PoC ha osservato autenticazione TLS riuscita, rifiuto sanificato di una credenziale alterata, primo invio e reinvio consegnati con allegato, hard bounce su un solo indirizzo riservato `.invalid` e relativa suppression automatica. Nessun valore SMTP, destinatario o risposta integrale è entrato nei log o nelle evidenze. Il titolare stima un massimo di 500 copie mensili, sotto il margine prudenziale di 2.500: HF-O07 è chiusa su `OCI_EMAIL_DELIVERY` come unico trasporto canonico.

La qualifica TD04 sul pannello Aruba reale resta un gate di collaudo successivo e separato: nessun accesso o invio Aruba reale è compreso in questa evidenza.
