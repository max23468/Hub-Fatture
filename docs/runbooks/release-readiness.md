# Readiness della release

Questo è il record candidato corrente. Un gate è chiuso soltanto quando la colonna **Riferimento** collega una prova osservata sul candidato esatto; una capacità già implementata ma non esercitata nell’ambiente richiesto resta aperta.

## Identità candidata

| Campo                | Stato corrente                                                                          |
| -------------------- | --------------------------------------------------------------------------------------- |
| Versione applicativa | `0.1.0`; nessun bump o tag di release autorizzato                                       |
| Commit candidato     | HEAD della PR/di `main`; SHA e check esatti si rileggono dalla fonte autorevole GitHub  |
| Digest immagine      | aperto: immagine candidata non costruita né attestata                                   |
| Schema candidato     | `017_historical_invoice_links.sql` verificato localmente                                |
| Kill switch          | configurazione Production fissata a `false`; readback sul candidato non ancora eseguito |

## Gate

| Gate                                                                          | Esito osservato                                                    | Riferimento                                                                                |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Audit trasversale del codice                                                  | Chiuso localmente; RC-01-RC-33 chiusi, nessun finding P0-P3 aperto | [Audit del release candidate](../audits/release-candidate-review.md), gate canonico locale |
| Migrazioni pulite e upgrade                                                   | Chiuso localmente                                                  | `src/db/migrations.server.test.ts`, schema `017_historical_invoice_links.sql`              |
| Import storico non approvabile prima del confronto                            | Chiuso localmente                                                  | `src/db/orders.server.test.ts`, percorso browser in `tests/e2e/readiness.spec.ts`          |
| Import iniziale e attivazione prudenziale delle sincronizzazioni              | Chiuso localmente                                                  | `src/orders.test.ts`, `src/db/connectors.server.test.ts`                                   |
| Flusso sintetico completo Chromium/WebKit                                     | Chiuso localmente                                                  | `npm run test:e2e:release-candidate`                                                       |
| Limiti, parser ostile, lease, stato fuori ordine, conflitti e audit atomico   | Chiuso localmente                                                  | `npm run check`, test Node/PostgreSQL e Playwright                                         |
| Helper sintetico macOS/Windows con Chrome/Edge                                | Chiuso soltanto con entrambi i check verdi sull’HEAD candidato     | workflow `CI`, job `Helper Aruba` per macOS/Chrome e Windows/Edge                          |
| Commit, digest, attestazione e scansione immagine                             | Aperto                                                             | richiede pubblicazione tecnica e workflow Production autorizzati                           |
| Deploy candidato e readback senza documenti, storico aperto, batch o permessi | Aperto                                                             | `scripts/production-release-candidate-readback.sh` pronto, non eseguito                    |
| Import reale degli ultimi sette giorni e riconciliazione Aruba                | Aperto                                                             | richiede accessi provider e attività reale non autorizzati                                 |
| Qualifica del pannello Aruba con upload controllato, rimozione e readback     | Aperto                                                             | richiede autorizzazione specifica; nessun invio consentito                                 |
| Contratto helper definitivo e HF-O06                                          | Aperto                                                             | dipende dalla qualifica del pannello reale                                                 |
| Fattura e TD04 reali validati senza invio                                     | Aperto                                                             | dipende dalla stessa sessione Aruba autorizzata                                            |
| Trasporto SMTP sul candidato con ricevuta e reinvio                           | Aperto                                                             | il PoC OCI è chiuso, ma il candidato non è stato esercitato end-to-end sul trasporto reale |
| Backup giornaliero corrente, copia Mac e RPO osservato                        | Aperto sul candidato                                               | ultima evidenza Production precede questo albero di lavoro                                 |
| Allarmi OCI e monitor HTTP sani                                               | Aperto sul candidato                                               | richiede readback provider corrente                                                        |
| Auto-merge Dependabot end-to-end                                              | Aperto                                                             | richiede una PR reale idonea o la prova temporanea prevista dal Master Plan                |
| Retention fiscale e tecnica                                                   | Aperto                                                             | HF-O08 richiede approvazione esterna                                                       |
| Approvazione del titolare per il canary                                       | Aperto                                                             | autorizzazione distinta non richiesta in questo ciclo                                      |

## Decisioni aperte

| ID     | Stato  | Fonte corrente                                                                                                        |
| ------ | ------ | --------------------------------------------------------------------------------------------------------------------- |
| HF-O01 | Chiusa | profilo fiscale derivato dagli XML accettati                                                                          |
| HF-O02 | Chiusa | numerazione, cambio anno e scarto documentati e testati                                                               |
| HF-O03 | Aperta | il download PDF è visibile nel pannello, ma il readback di un PDF ufficiale sul candidato non è ancora stato eseguito |
| HF-O04 | Chiusa | mapping Shopify verificato in Development e fixture anonimizzata                                                      |
| HF-O05 | Chiusa | forma eBay verificata in sola lettura; rimborso ambiguo resta fail-closed                                             |
| HF-O06 | Aperta | locatori e stati restano candidati fino alla prova controllata sul pannello reale                                     |
| HF-O07 | Chiusa | `OCI_EMAIL_DELIVERY` scelto come unico trasporto canonico                                                             |
| HF-O08 | Aperta | retention definitiva da approvare                                                                                     |
| HF-O09 | Chiusa | Brand Foundation approvata                                                                                            |

## Runbook applicabili

La procedura operativa riusa senza duplicarli [Produzione OCI](production.md), [Aruba manuale](aruba-manual.md), [Backup e ripristino](backup-restore.md), [Incidenti Production](incidents.md) e [PoC OCI Email Delivery](oci-email-delivery-poc.md). Nessun deploy, upload Aruba, invio, e-mail reale, release o attivazione Production è stato eseguito durante la preparazione di questo record.
