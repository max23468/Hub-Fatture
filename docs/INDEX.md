# Indice della documentazione

| Documento                                                                            | Scopo                                                     | Stato       | Fonte canonica |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------- | ----------- | -------------- |
| [Hub Fatture Master Plan](Hub_Fatture_MASTER_PLAN.md)                                | Prodotto, UX, architettura, test, distribuzione e roadmap | Consolidato | Sì             |
| [Versioning](contracts/versioning.md)                                                | SemVer, selezione release e candidati concorrenti         | Approvata   | Sì             |
| [Readiness toolchain](evidence/toolchain-readiness.md)                               | Fonti, controlli e limiti della toolchain                 | Corrente    | No             |
| [Fondazioni locali](evidence/local-foundations.md)                                   | Capacità e gate ripetibili delle fondazioni applicative   | Corrente    | No             |
| [Brand Foundation](brand/brand-foundation.md)                                        | Identità visiva e tono UI minimi                          | Approvata   | Sì             |
| [Glossario](glossario.md)                                                            | Terminologia italiana applicativa                         | Corrente    | Sì             |
| [Registro errori](contracts/error-registry.md)                                       | Codici stabili e comportamento operativo                  | Corrente    | Sì             |
| [Dominio ordini](contracts/order-domain.md)                                          | Fonti, import, raggruppamento e concorrenza               | Corrente    | Sì             |
| [Inventario segreti](runbooks/secret-inventory.md)                                   | Nomi logici, custodia e rotazione senza valori            | Corrente    | Sì             |
| [Ordini e preparazione fattura](evidence/order-domain.md)                            | Capacità e gate ripetibili del dominio                    | Corrente    | No             |
| [Connettori Shopify ed eBay](evidence/connectors.md)                                 | Contratti API, fixture e gate dei provider                | Corrente    | No             |
| [Audit Aruba e profilo FatturaPA](evidence/aruba-fatturapa-profile.md)               | Profilo fiscale, numerazione e prove anonimizzate         | Corrente    | No             |
| [Attivazione profilo fiscale](runbooks/fiscal-profile.md)                            | Procedura sicura da XML accettato a profilo versionato    | Corrente    | Sì             |
| [API profilo fiscale](contracts/fiscal-profile-api.md)                               | Lettura e attivazione controllata del profilo applicativo | Corrente    | Sì             |
| [Contratto API Aruba](contracts/aruba-api.md)                                        | Autorità API, gruppi, documenti, stati, file e limiti v2  | Corrente    | Sì             |
| [Probe API Aruba](runbooks/aruba-api-read-probe.md)                                  | Procedura read-only senza persistenza di credenziali      | Corrente    | Sì             |
| [Qualifica API Aruba](evidence/aruba-api-qualification.md)                           | Stato delega, test locali e gate API qualificati          | Verificato  | No             |
| [Inbound API Aruba](evidence/aruba-api-inbound.md)                                   | Evidenze Production dell’inbound API canonico             | Storico     | No             |
| [Outbound API Aruba](evidence/aruba-api-outbound.md)                                 | Dry-run, arresti, manifest ed esiti senza invio reale     | Corrente    | No             |
| [Transizione API Aruba](evidence/aruba-api-transition.md)                            | Chiusura del ritiro browser e relativi ratchet            | Corrente    | No             |
| [ADR API Aruba primaria](adr/0001-api-aruba-canale-primario.md)                      | Destinazione API e migrazione progressiva                 | Approvato   | Sì             |
| [ADR credenziale Aruba](adr/0002-credenziale-aruba-cifrata-nel-runtime.md)           | Custodia, rotazione e recovery della connessione          | Approvato   | Sì             |
| [ADR sincronizzazione Aruba](adr/0003-polling-aruba-senza-callback.md)               | Polling e readback autorevoli senza callback              | Approvato   | Sì             |
| [ADR canary Aruba](adr/0004-permesso-monouso-canary-aruba.md)                        | Decisione storica sul permesso monouso                    | Superato    | Sì             |
| [ADR base applicativa Debian 13](adr/0005-base-applicativa-debian-13-trixie-slim.md) | Base container, aggiornamenti e rollback applicativo      | Approvato   | Sì             |
| [ADR primo invio ordinario](adr/0006-primo-invio-aruba-ordinario.md)                 | Primo effetto fiscale reale nel normale flusso operativo  | Approvato   | Sì             |
| [Piano integrazione API Aruba](plans/aruba-api-integration.md)                       | Architettura API, flussi, gate e milestone                | Approvato   | Sì             |
| [Piano invio e monitoraggio Aruba](plans/aruba-outbound-monitoring.md)               | Refresh, ricerca, invio TD01 e monitoraggio SdI           | Approvato   | Sì             |
| [Procedura manuale Aruba](runbooks/aruba-manual.md)                                  | Export, upload manuale, readback e import                 | Corrente    | Sì             |
| [Integrazione Aruba locale](evidence/aruba-helper.md)                                | Evidenza storica del percorso browser ritirato            | Storico     | No             |
| [Note di credito ed e-mail](contracts/credit-notes-email.md)                         | Contratto TD04, trigger e trasporto cliente               | Approvato   | Sì             |
| [Conservazione e cancellazione](contracts/retention-deletion.md)                     | Durate, eccezioni e procedura di cancellazione            | Approvato   | Sì             |
| [PoC OCI Email Delivery](runbooks/oci-email-delivery-poc.md)                         | Preflight e prova Development con stop gate               | Completato  | Sì             |
| [Evidenza note ed e-mail](evidence/credit-notes-email.md)                            | Prove sintetiche e gate del trasporto                     | Verificato  | No             |
| [Produzione OCI](runbooks/production.md)                                             | Deploy, readback, rollback e hardening                    | Corrente    | Sì             |
| [Backup e ripristino](runbooks/backup-restore.md)                                    | Backup cifrato, copia Mac e restore drill                 | Corrente    | Sì             |
| [Incidenti Production](runbooks/incidents.md)                                        | Triage P0-P2 e kill switch                                | Corrente    | Sì             |
| [Evidenza Production OCI](evidence/production-oci.md)                                | Gate locali e ricevute remote della Production OCI        | Verificato  | No             |
| [Migrazione Debian 13 Slim](evidence/debian-13-slim-migration.md)                    | Baseline, qualifica locale e rollback dell’immagine app   | Corrente    | No             |
| [Recupero pubblicazione 0.3.63](evidence/release-0.3.63-recovery.md)                 | Deroga una tantum al flusso PR della release              | Storico     | No             |
| [Finding tecnici attivi](audits/active-findings.md)                                  | Vista breve del debito tecnico ancora azionabile          | Corrente    | No             |
| [Audit del release candidate](audits/release-candidate-review.md)                    | Registro storico delle verifiche e relative risoluzioni   | Storico     | No             |
| [Readiness della release](runbooks/release-readiness.md)                             | Record corrente dei gate tecnici e del go-live            | Corrente    | No             |

Nuovi contratti, evidenze e runbook vengono creati soltanto quando esiste contenuto reale.
