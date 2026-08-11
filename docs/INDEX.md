# Indice della documentazione

| Documento                                                              | Scopo                                                     | Stato       | Fonte canonica |
| ---------------------------------------------------------------------- | --------------------------------------------------------- | ----------- | -------------- |
| [Hub Fatture Master Plan](Hub_Fatture_MASTER_PLAN.md)                  | Prodotto, UX, architettura, test, distribuzione e roadmap | Consolidato | Sì             |
| [Readiness toolchain](evidence/toolchain-readiness.md)                 | Fonti, controlli e limiti della toolchain                 | Corrente    | No             |
| [Fondazioni locali](evidence/local-foundations.md)                     | Capacità e gate ripetibili delle fondazioni applicative   | Corrente    | No             |
| [Brand Foundation](brand/brand-foundation.md)                          | Identità visiva e tono UI minimi                          | Approvata   | Sì             |
| [Glossario](glossario.md)                                              | Terminologia italiana applicativa                         | Corrente    | Sì             |
| [Registro errori](contracts/error-registry.md)                         | Codici stabili e comportamento operativo                  | Corrente    | Sì             |
| [Dominio ordini](contracts/order-domain.md)                            | Fonti, import, raggruppamento e concorrenza               | Corrente    | Sì             |
| [Inventario segreti](runbooks/secret-inventory.md)                     | Nomi logici, custodia e rotazione senza valori            | Corrente    | Sì             |
| [Ordini e preparazione fattura](evidence/order-domain.md)              | Capacità e gate ripetibili del dominio                    | Corrente    | No             |
| [Connettori Shopify ed eBay](evidence/connectors.md)                   | Contratti API, fixture e gate dei provider                | Corrente    | No             |
| [Audit Aruba e profilo FatturaPA](evidence/aruba-fatturapa-profile.md) | Profilo fiscale, numerazione e prove anonimizzate         | Corrente    | No             |
| [Attivazione profilo fiscale](runbooks/fiscal-profile.md)              | Procedura sicura da XML accettato a profilo versionato    | Corrente    | Sì             |
| [Contratto helper Aruba](contracts/aruba-helper.md)                    | Manifest, sicurezza e locatori candidati                  | Candidato   | Sì             |
| [Procedura manuale Aruba](runbooks/aruba-manual.md)                    | Export, upload manuale, readback e import                 | Corrente    | Sì             |
| [Integrazione Aruba locale](evidence/aruba-helper.md)                  | Capacità locali e gate reale pre-Canary                   | Corrente    | No             |
| [Note di credito ed e-mail](contracts/credit-notes-email.md)           | Contratto TD04, trigger e trasporto cliente               | Candidato   | Sì             |
| [PoC OCI Email Delivery](runbooks/oci-email-delivery-poc.md)           | Preflight e prova Development con stop gate               | Completato  | Sì             |
| [Evidenza note ed e-mail](evidence/credit-notes-email.md)              | Prove sintetiche e gate trasporto residuo                 | Corrente    | No             |
| [Produzione OCI](runbooks/production.md)                               | Deploy, readback, rollback e hardening                    | Corrente    | Sì             |
| [Backup e ripristino](runbooks/backup-restore.md)                      | Backup cifrato, copia Mac e restore drill                 | Corrente    | Sì             |
| [Incidenti Production](runbooks/incidents.md)                          | Triage P0-P2 e kill switch                                | Corrente    | Sì             |
| [Evidenza Production OCI](evidence/production-oci.md)                  | Gate locali e ricevute remote della Production OCI        | Verificato  | No             |
| [Audit del release candidate](audits/release-candidate-review.md)      | Audit trasversale e finding del candidato corrente        | Corrente    | No             |
| [Readiness della release](runbooks/release-readiness.md)               | Gate chiusi, prove collegate e blocchi prima del canary   | Corrente    | No             |

Nuovi contratti, evidenze e runbook vengono creati soltanto quando esiste contenuto reale.
