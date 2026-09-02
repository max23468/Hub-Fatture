# Versioning di Hub Fatture

Questo documento definisce la convenzione di versioning applicativa. La roadmap e i criteri di uscita restano quelli del Master Plan; questa policy assegna soltanto significato ai numeri di versione e non crea milestone aggiuntive.

## Regole

Hub Fatture usa versioni `MAJOR.MINOR.PATCH` senza suffissi prerelease.

- `PATCH` identifica ogni nuova release runtime Production compatibile all'interno della stessa tranche funzionale. Correzioni, hardening e miglioramenti incrementali avanzano il patch.
- Prima della `1.0.0`, `MINOR` identificava i treni principali della roadmap. Dalla `1.0.0`, avanza per una tranche funzionale coerente e autorizzata dal titolare, senza implicare deploy o attivazioni Production.
- `MAJOR` è `1` dalla prima release operativa completa; un incremento futuro richiede una decisione esplicita sul contratto di prodotto.
- Modifiche esclusivamente documentali, di test o di governance non richiedono un bump applicativo.
- Non si usano `alpha`, `beta`, `rc` o altri prerelease tag. Il commit e il digest identificano le iterazioni del candidato prima della pubblicazione definitiva.
- Più correzioni runtime assorbite prima della pubblicazione possono completare lo stesso candidato
  già versionato finché il relativo tag `vMAJOR.MINOR.PATCH` non esiste; dopo il tag immutabile,
  qualunque nuova modifica runtime deve avanzare almeno il patch.

## Treni storici fino alla 1.0

| Fase della roadmap                 | Versione               | Significato                                                                                                                      |
| ---------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Inbound API primario               | `0.3.x`                | Treno corrente; prosegue dalla release Production `0.3.96` fino alla chiusura della fase inbound                                 |
| Outbound API senza invio reale     | `0.4.x`                | `0.4.0` è la prima release runtime che entra effettivamente nella fase outbound                                                  |
| Parità e transizione browser       | `0.5.x`                | `0.5.0` apre la fase in cui le API diventano la fonte automatica per le capacità qualificate e si decide il destino degli helper |
| Stabilizzazione successiva         | `0.6.x`                | Hardening, pulizia e preparazione del candidato; non è una milestone aggiuntiva                                                  |
| Ricertificazione release candidate | `1.0.0` non pubblicata | Il candidato assume già la versione definitiva e viene distribuito con invii ordinari disabilitati                               |
| Qualifica tecnica Production       | stesso `1.0.0`         | I gate tecnici verificano il candidato con invii reali disabilitati                                                              |
| Go-live                            | `1.0.0`                | Lo stesso artefatto validato viene promosso e pubblicato come release definitiva                                                 |

Le serie `0.7.x`, `0.8.x` e `0.9.x` non fanno parte della roadmap corrente e non vanno introdotte per riempire artificialmente la distanza dalla `1.0.0`.

## Serie stabile 1.x

La `1.1.0` identifica la tranche operativa richiesta dal titolare dopo il go-live: proiezione unica delle code, Controlli paginati e assegnabili, retention osservabile e hardening e-mail/Aruba. Le correzioni successive che non ampliano questa tranche avanzano `1.1.x`; una nuova capacità di prodotto distinta richiede una nuova autorizzazione prima di scegliere `1.2.0`.

## Candidato 1.0.0

Quando la fase di ricertificazione congela un candidato, `package.json` passa a `1.0.0`, ma la GitHub Release resta non pubblicata. La qualifica tecnica conserva l’identità dell’artefatto tramite SHA e digest senza richiedere invii reali.

Se la qualifica tecnica richiede una modifica al codice, si produce un nuovo SHA/digest mantenendo `1.0.0` non pubblicata e si ripetono i gate tecnici interessati. Il go-live non introduce modifiche runtime; se una modifica si rende necessaria, si torna ai gate exact-SHA applicabili senza riaprire formalmente la milestone di ricertificazione già chiusa.

La pubblicazione della GitHub Release `1.0.0` avviene soltanto dopo la qualifica tecnica e l’approvazione finale previste dalla roadmap. L’abilitazione degli invii Production ordinari resta un’autorizzazione separata del go-live.

## Relazione con le release tecniche

Il numero di versione descrive lo stato del prodotto, mentre SHA, digest immagine, schema e manifest descrivono l'identità tecnica esatta della distribuzione. Le release intermedie `0.x` continuano a essere immutabili dopo il readback Production secondo il workflow corrente.

Questa policy non autorizza deploy, dry-run, upload o invii Aruba e non modifica i gate o le autorizzazioni definiti nel Master Plan.
