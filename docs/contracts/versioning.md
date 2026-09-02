# Versioning di Hub Fatture

Questo documento definisce la convenzione di versioning applicativa fino alla prima release stabile. La roadmap e i criteri di uscita restano quelli del Master Plan; questa policy assegna soltanto significato ai numeri di versione e non crea milestone aggiuntive.

## Regole

Hub Fatture usa versioni `MAJOR.MINOR.PATCH` senza suffissi prerelease.

- `PATCH` identifica ogni nuova release runtime Production all'interno dello stesso treno di sviluppo. Correzioni, hardening, miglioramenti infrastrutturali e completamenti incrementali della stessa fase avanzano il patch.
- `MINOR` cambia quando si entra in una nuova fase funzionale principale della roadmap pre-1.0. Non misura una percentuale di completamento.
- `MAJOR` passa a `1` soltanto per il candidato destinato alla prima release operativa completa.
- Modifiche esclusivamente documentali, di test o di governance non richiedono un bump applicativo.
- Non si usano `alpha`, `beta`, `rc` o altri prerelease tag. Il commit e il digest identificano le iterazioni del candidato prima della pubblicazione definitiva.

## Treni fino alla 1.0

| Fase della roadmap                 | Versione               | Significato                                                                                                                      |
| ---------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Inbound API primario               | `0.3.x`                | Treno corrente; prosegue dalla release Production `0.3.96` fino alla chiusura della fase inbound                                 |
| Outbound API senza invio reale     | `0.4.x`                | `0.4.0` è la prima release runtime che entra effettivamente nella fase outbound                                                  |
| Parità e transizione browser       | `0.5.x`                | `0.5.0` apre la fase in cui le API diventano la fonte automatica per le capacità qualificate e si decide il destino degli helper |
| Stabilizzazione successiva         | `0.6.x`                | Hardening, pulizia e preparazione del candidato; non è una milestone aggiuntiva                                                  |
| Ricertificazione release candidate | `1.0.0` non pubblicata | Il candidato assume già la versione definitiva e viene distribuito con invii ordinari disabilitati                               |
| Canary Production TD01 opzionale   | stesso `1.0.0`         | Se eseguito, il canary usa lo stesso SHA e digest dei gate tecnici finali                                                        |
| Go-live                            | `1.0.0`                | Lo stesso artefatto validato viene promosso e pubblicato come release definitiva                                                 |

Le serie `0.7.x`, `0.8.x` e `0.9.x` non fanno parte della roadmap corrente e non vanno introdotte per riempire artificialmente la distanza dalla `1.0.0`.

## Candidato 1.0.0

Quando la fase di ricertificazione congela un candidato, `package.json` passa a `1.0.0`, ma la GitHub Release resta non pubblicata. I gate tecnici identificano l’artefatto tramite SHA e digest; l’eventuale canary opzionale deve usare lo stesso artefatto.

Il canary reale è opzionale e può essere registrato come `SKIPPED` senza bloccare la release. Se viene eseguito e richiede una modifica al codice, il candidato precedente è scartato e si produce un nuovo SHA/digest mantenendo `1.0.0` non pubblicata; si ripetono i gate tecnici interessati, il deploy exact-SHA e il preflight immediatamente precedente all’invio. Il go-live non introduce modifiche runtime; se una modifica si rende necessaria, si torna ai gate exact-SHA interessati prima di procedere.

La pubblicazione della GitHub Release `1.0.0` avviene dopo i gate tecnici finali e l’approvazione prevista dalla roadmap; non richiede un invio Aruba reale.

## Relazione con le release tecniche

Il numero di versione descrive lo stato del prodotto, mentre SHA, digest immagine, schema e manifest descrivono l'identità tecnica esatta della distribuzione. Le release intermedie `0.x` continuano a essere immutabili dopo il readback Production secondo il workflow corrente.

Questa policy non autorizza deploy, dry-run, upload o invii Aruba e non modifica i gate o le autorizzazioni definiti nel Master Plan.
