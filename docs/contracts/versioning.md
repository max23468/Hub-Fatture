# Versioning di Hub Fatture

Questo documento definisce la convenzione di versioning applicativa. La roadmap e i criteri di
uscita restano quelli del Master Plan; questa policy assegna significato ai numeri di versione,
stabilisce quando sceglierli e non crea milestone aggiuntive.

## 1. Forma e fonti

Hub Fatture usa versioni `MAJOR.MINOR.PATCH` senza suffissi prerelease.

- `package.json#version` è la fonte applicativa e coincide sempre con `package-lock.json`.
- Il tag remoto immutabile `vMAJOR.MINOR.PATCH` identifica una release pubblicata; SHA, digest
  immagine, schema e manifest ne identificano l'artefatto esatto.
- Nei piani e nei branch non si prenotano numeri. La versione viene calcolata sulla versione stabile
  più alta realmente assorbita in `origin/main` e sui tag remoti, dopo aver integrato i lavori che
  devono precedere il candidato.
- Negli artefatti si scrivono sempre tre componenti: `1.2.0`, non `1.2`.
- Modifiche esclusivamente documentali, di test o di governance non richiedono un bump applicativo.
- Non si usano `alpha`, `beta`, `rc` o altri prerelease tag. Il commit e il digest identificano le iterazioni del candidato prima della pubblicazione definitiva.

## 2. Classificazione SemVer

### 2.1 PATCH

`PATCH` identifica una release runtime Production compatibile all'interno della tranche funzionale
corrente. Comprende correzioni, hardening, refactoring, aggiornamenti tecnici e completamenti
incrementali già compresi nel perimetro autorizzato della tranche.

Il numero di file, schermate, migrazioni o giorni di lavoro non trasforma da solo una modifica in
`MINOR` o `MAJOR`. Dopo un tag immutabile, qualunque nuova modifica runtime avanza almeno `PATCH`.

### 2.2 MINOR

Dalla `1.0.0`, `MINOR` apre una capacità di prodotto distinta, coerente e autorizzata dal titolare,
senza dichiarare una nuova generazione. Il primo rilascio Production che rende disponibile la
tranche usa la successiva `MINOR` libera e azzera `PATCH`; completamenti e correzioni compatibili
della stessa tranche avanzano poi `PATCH`.

Se una tranche pianificata richiede più rilasci, non riceve una nuova `MINOR` a ogni passaggio. Una
capacità successiva che abbia obiettivo e criteri di uscita autonomi apre invece una nuova tranche.

### 2.3 MAJOR

`MAJOR` non misura soltanto incompatibilità tecnica. Può dichiarare una nuova generazione del
prodotto anche quando la migrazione è compatibile, ma richiede sempre una decisione esplicita del
titolare e un cambiamento sostanziale in almeno due di questi assi:

1. proposta di valore o problema principale risolto dal prodotto;
2. flussi essenziali, responsabilità, ruoli o autorizzazioni dell'utente;
3. modello persistente od operativo, con nuova strategia di migrazione, cutover o rollback;
4. perimetro fiscale, provider o contratti d'integrazione ufficialmente supportati.

La rottura di un contratto pubblico supportato da consumatori esterni, qualora venga introdotto in
futuro, richiede comunque una `MAJOR`. Refactoring interni, sostituzioni di implementazione,
quantità di codice e semplice ampiezza progettuale non sono soglie sufficienti.

## 3. Unità di release e concorrenza

- Una release Production corrisponde a una sola versione, anche se raccoglie più commit o modifiche
  runtime correlate.
- Bump e voce di `CHANGELOG.md` appartengono alla stessa PR runtime destinata alla pubblicazione e
  precedono il merge.
- Più correzioni assorbite prima della pubblicazione possono completare lo stesso candidato finché
  il relativo tag non esiste. Dopo il tag, il candidato è immutabile.
- Se un altro lavoro runtime viene pubblicato per primo, il branch ancora aperto si riallinea a
  `origin/main`, rilegge i tag e ricalcola la propria versione. Non mantiene un numero prenotato.
- Un conflitto di versione o changelog non si risolve creando un secondo bump artificiale: si
  riclassifica il diff cumulativo rispetto all'ultima release realmente pubblicata.

## 4. Matrice decisionale

| Cambiamento                                                 | Versione                                 |
| ----------------------------------------------------------- | ---------------------------------------- |
| Solo documentazione, test o governance                      | nessun bump                              |
| Fix o hardening runtime nella tranche corrente              | `PATCH` successiva                       |
| Completamento compatibile di una tranche già aperta         | `PATCH` successiva                       |
| Prima release di una capacità di prodotto distinta          | `MINOR` successiva, `PATCH=0`            |
| Nuova generazione esplicita con almeno due assi sostanziali | `MAJOR` successiva, `MINOR=0`, `PATCH=0` |
| Rottura futura di un contratto pubblico supportato          | `MAJOR` successiva                       |

In caso di dubbio fra `PATCH` e `MINOR`, decide l'esistenza di una nuova capacità osservabile con
obiettivo e criteri di uscita propri. In caso di dubbio fra `MINOR` e `MAJOR`, resta `MINOR` finché
non esistono sia la dichiarazione esplicita di nuova generazione sia la soglia dei due assi.

## 5. Treni storici fino alla 1.0

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

## 6. Serie stabile 1.x

La `1.1.0` identifica la tranche operativa richiesta dal titolare dopo il go-live: proiezione unica
delle code, Controlli paginati e assegnabili, retention osservabile e hardening e-mail/Aruba. Le
correzioni compatibili di quella tranche avanzano `1.1.x`.

Una nuova capacità distinta usa la successiva `MINOR` libera rilevata al momento della preparazione
della release. L'esempio `1.2.0` non costituisce una prenotazione: se quella versione è già stata
pubblicata, la tranche successiva userà `1.3.0`, e così via.

## 7. Candidato storico 1.0.0

Quando la fase di ricertificazione congela un candidato, `package.json` passa a `1.0.0`, ma la GitHub Release resta non pubblicata. La qualifica tecnica conserva l’identità dell’artefatto tramite SHA e digest senza richiedere invii reali.

Se la qualifica tecnica richiede una modifica al codice, si produce un nuovo SHA/digest mantenendo `1.0.0` non pubblicata e si ripetono i gate tecnici interessati. Il go-live non introduce modifiche runtime; se una modifica si rende necessaria, si torna ai gate exact-SHA applicabili senza riaprire formalmente la milestone di ricertificazione già chiusa.

La pubblicazione della GitHub Release `1.0.0` avviene soltanto dopo la qualifica tecnica e l’approvazione finale previste dalla roadmap. L’abilitazione degli invii Production ordinari resta un’autorizzazione separata del go-live.

## 8. Relazione con le release tecniche

Il numero di versione descrive lo stato del prodotto, mentre SHA, digest immagine, schema e manifest descrivono l'identità tecnica esatta della distribuzione. Le release intermedie `0.x` continuano a essere immutabili dopo il readback Production secondo il workflow corrente.

Questa policy non autorizza deploy, dry-run, upload o invii Aruba e non modifica i gate o le autorizzazioni definiti nel Master Plan.
