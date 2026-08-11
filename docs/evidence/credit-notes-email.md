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

## Ricevuta PoC OCI Email Delivery

- Ambiente e versione: Development locale sulla baseline applicativa `42ee98d088009cfe8289a2a43f1827a53e4b20d7` e configurazione candidata `778dbd4aa0e09e235e2772e2d11a88b66029c609`; nessun deploy o riavvio dello stack già attivo.
- Target: tenancy `matteof`, compartimento radice, regione `eu-milan-1` (Italy Northwest, Milano), trasporto `OCI_EMAIL_DELIVERY` provato direttamente con Nodemailer e TLS obbligatorio.
- Readback OCI e DNS del 2026-08-11T13:04:36Z: dominio `numisleo.it` `ACTIVE`, creato il 2026-08-11T11:04:01Z, OCID con suffisso `zb4q5fteu4ka`; DKIM `hubfatture` `ACTIVE`, creato il 2026-08-11T11:06:11Z, OCID con suffisso `6aj4ra4fxb2a`; un mittente approvato `ACTIVE`, creato il 2026-08-11T11:11:59Z, OCID con suffisso `hajgjmonxplq`. I quattro DNS autorevoli Aruba e i resolver pubblici `1.1.1.1` e `8.8.8.8` restituiscono l'inclusione SPF OCI Europa. Il valore del mittente e gli OCID completi restano fuori dal repository.

| Caso                        | Timestamp UTC        | Identificativo sanitizzato                   | Risultato e readback                                                                                                                              |
| --------------------------- | -------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Autenticazione TLS          | 2026-08-11T12:34:51Z | credenziale SMTP dedicata                    | autenticazione riuscita senza stampare username, password o risposta SMTP                                                                         |
| Primo invio controllato     | 2026-08-11T12:36:45Z | Message-ID `m6-oci-poc-inbox-…@numisleo.it`  | un destinatario accettato, nessun rifiuto; il titolare ha confermato messaggio e allegato nella casella controllata entro il 2026-08-11T12:47:01Z |
| Mancata consegna permanente | 2026-08-11T12:39:18Z | suppression OCI con suffisso `iqnekwcm6doq`  | submission accettata; suppression creata il 2026-08-11T12:39:28Z con motivo `HARDBOUNCE`, poi riletta dalla fonte autorevole                      |
| Reinvio controllato         | 2026-08-11T12:39:53Z | Message-ID `m6-oci-poc-resend-…@numisleo.it` | un destinatario accettato, nessun rifiuto; il titolare ha confermato anche il secondo messaggio e l'allegato entro il 2026-08-11T12:47:01Z        |
| Credenziale alterata        | 2026-08-11T12:40:52Z | errore sanificato `EAUTH`                    | autenticazione rifiutata senza risposta SMTP integrale                                                                                            |

I Message-ID completi dei due messaggi non sono versionati perché incorporano un identificatore univoco; prefisso, dominio, timestamp, conteggio accettati/rifiutati e readback umano consentono di individuarli nella casella controllata senza pubblicare destinatario o intestazioni. Il destinatario della mancata consegna non deve essere riutilizzato e la suppression non va rimossa.

Rollback disponibile, non eseguito: mantenere o riportare `SMTP_TRANSPORT=SYNTHETIC`, revocare la credenziale SMTP dedicata e rimuoverla dal secret store; soltanto dopo il readback dell'assenza di invii attivi, eliminare mittente, DKIM e dominio OCI e togliere l'inclusione SPF OCI. L'app Development già in esecuzione è rimasta `SYNTHETIC`, quindi un problema del PoC non può modificare lo stato fiscale né produrre un invio applicativo.

## Trasporto esterno verificato

Nella regione di Milano sono stati verificati dominio OCI, DKIM, mittente approvato e SPF pubblico. Compose passa la stessa configurazione SMTP ad app e worker e conserva il trasporto sintetico come protezione predefinita. La credenziale dedicata resta nel file locale ignorato da Git con permessi riservati al titolare. Il PoC ha osservato autenticazione TLS riuscita, rifiuto sanificato di una credenziale alterata, primo invio e reinvio consegnati con allegato, hard bounce su un solo indirizzo riservato `.invalid` e relativa suppression automatica. Nessun valore SMTP, destinatario o risposta integrale è entrato nei log o nelle evidenze. Il titolare stima un massimo di 500 copie mensili, sotto il margine prudenziale di 2.500: HF-O07 è chiusa su `OCI_EMAIL_DELIVERY` come unico trasporto canonico.

La qualifica TD04 sul pannello Aruba reale resta un gate di collaudo successivo e separato: nessun accesso o invio Aruba reale è compreso in questa evidenza.
