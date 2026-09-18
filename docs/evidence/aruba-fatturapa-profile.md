# Audit Aruba e profilo FatturaPA

## Perimetro e metodo

Audit eseguito il 10 agosto 2026 nel pannello Aruba Production del titolare, tramite Chrome e in sola lettura. Non sono state modificate impostazioni, non è stata attivata la 2FA, non sono stati creati o caricati documenti e non è stato avviato alcun invio.

Sono stati analizzati un XML TD01 e un XML TD04 già accettati dallo SdI. I file originali sono rimasti fuori dal repository; le fixture versionate contengono soltanto identità, indirizzi, importi e riferimenti sintetici. Non sono state conservate schermate del pannello.

I due originali sono archiviati cifrati nel recovery kit locale di Hub Fatture e ne è stato verificato il round-trip byte per byte. Le copie temporanee in chiaro sono state eliminate.

Le righe dell'albo, del civico, dell'unità di misura, del progressivo, della scadenza e della serializzazione derivano da un confronto successivo, condotto in sola lettura su tutti gli XML emessi dal pannello e già riconciliati in Production: 240 documenti fra giugno e settembre 2026, 238 TD01 e 2 TD04. Nessun file è stato aggiunto al repository.

Unità di misura e scadenza non sono regole del pannello ma dati delle sue anagrafiche. L'unità segue l'articolo: nessuna delle 111 descrizioni osservate alterna `NR` e assenza. La scadenza segue il cliente: 30 dei 31 clienti ricorrenti hanno sempre gli stessi termini. L'applicazione non dispone di quelle anagrafiche e applica quindi un solo valore: `NR`, coerente con la quantità sempre valorizzata, e trenta giorni, il termine più frequente.

## Profilo osservato

| Campo                           | Evidenza osservata                                                                                       | Profilo applicativo                                       |
| ------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Formato                         | `FPR12` in TD01 e TD04                                                                                   | `FPR12`                                                   |
| Regime fiscale                  | XML accettati e Profilo fiscale Aruba                                                                    | `RF14`                                                    |
| Natura del regime del margine   | Riga e riepilogo della TD01 accettata                                                                    | `N5`                                                      |
| Riferimento normativo           | XML accettati                                                                                            | `Regime del margine Art. 36 41/95`                        |
| Tipo fattura                    | XML accettato                                                                                            | `TD01`                                                    |
| Tipo nota di credito            | XML accettato                                                                                            | `TD04`                                                    |
| Condizioni di pagamento         | XML accettati                                                                                            | `TP02`                                                    |
| Modalità fattura predefinita    | XML TD01 accettato                                                                                       | `MP08`                                                    |
| Modalità nota                   | XML TD04 accettato                                                                                       | `MP05`                                                    |
| Serie privati                   | Impostazioni Aruba, associata a fatture e note                                                           | `FPR`                                                     |
| Formato numero                  | Impostazioni e documenti accettati                                                                       | `FPR ####/##`                                             |
| Periodicità                     | Impostazioni Aruba                                                                                       | annuale, azzerata all’inizio dell’anno solare             |
| Destinatario senza canale       | TD04 accettata                                                                                           | `0000000`; PEC soltanto quando presente                   |
| Destinatario estero             | Specifica FatturaPA e regola pannello                                                                    | `XXXXXXX`                                                 |
| Spedizione, sconti e trasporto  | nessun blocco separato nei campioni                                                                      | assorbiti nella riga semplificata e nel totale ordine     |
| Arrotondamento, bollo, ritenuta | assenti nei campioni                                                                                     | non generati                                              |
| Albo professionale del cedente  | quattro nodi valorizzati in 240 documenti su 240                                                         | ripresi dal profilo e riemessi quando presenti            |
| Civico della sede cedente       | `NumeroCivico` separato in 240 documenti su 240                                                          | campo distinto nel profilo e nel documento                |
| Unità di misura delle righe     | `NR` o assente secondo l’articolo dell’anagrafica prodotti Aruba: 117 righe con `NR`, 128 senza          | `NR` su ogni riga con quantità                            |
| Progressivo di invio            | numero del documento senza anno in 240 documenti su 240                                                  | progressivo del documento                                 |
| Scadenza del pagamento          | termini del cliente nell’anagrafica Aruba: +30 giorni in 139 documenti, stessa data in 101               | data documento più trenta giorni                          |
| Serializzazione                 | BOM UTF-8, `encoding="utf-8"`, `xmlns=""` su header e body, nessun a capo finale in 240 documenti su 240 | stessa; cambia solo l’ordine degli attributi della radice |
| PDF e file ufficiali            | anteprima con download separati PDF, XML e P7M                                                           | download/readback Aruba, non PDF generato da HF           |

La TD04 storica contiene anche una riga al 22% estranea al perimetro 1.x, oltre alla riga `N5`. Il generatore non la replica: per le vendite comprese nel prodotto tutte le righe documentali applicano il profilo del margine `N5`. Sono invece conservate le differenze strutturali pertinenti alla nota: `TD04` e modalità `MP05`.

La modalità della singola fattura è un dato documentale modificabile prima dell'approvazione, non parte invariabile del profilo del cedente: `MP01`, `MP05` e `MP08` sono ammesse con condizione `TP02`. Il profilo conserva `MP08` come default; l'import storico valida e archivia la modalità effettivamente presente nell'XML Aruba senza usarla per dichiarare incompatibile il resto del profilo fiscale.

I dati bancari restano opzionali e non vengono emessi: appartengono al bonifico e non al profilo del cedente. I nodi dell'albo professionale, invece, il pannello li valorizza su ogni documento, quindi il profilo li acquisisce dall'XML sorgente e il generatore li riemette; un profilo attivato prima che fossero previsti non li contiene e continua a produrre documenti validi senza nodi vuoti. L'allineamento non tocca la validità: la validazione XSD passa in entrambi i casi.

Il PDF di cortesia è generato da Aruba in entrambi i percorsi, ma il pannello applica logo, messaggio di chiusura e codice dell'anagrafica prodotti soltanto ai documenti creati al suo interno. L'endpoint `invoice/upload` accetta solo il file fiscale e non espone alcuna opzione di resa, quindi il PDF restituito per un documento trasmesso dall'applicazione resta privo di quelle personalizzazioni.

## Numerazione e scarto

Fatture e note condividono la serie privata `FPR`. La numerazione annuale riparte da uno a inizio anno e il database impone l'unicità di serie, anno e progressivo. L'ultimo progressivo osservato resta nei materiali cifrati e viene acquisito nel profilo `AUDITED` dal documento accettato più recente fra TD01 e TD04, senza pubblicarne il valore; la numerazione applicativa parte dal maggiore fra quel saldo e i documenti già approvati. Il titolare ha confermato che la data documento coincide con il giorno dell'approvazione: un ordine del 31 dicembre approvato a gennaio usa quindi data e numerazione del nuovo anno. Se cambia il giorno fra proiezione e approvazione, l'hash stale blocca la numerazione e richiede una nuova rilettura.

Una ricevuta di scarto non libera il numero per un documento diverso. Il documento corretto conserva stessa data e stesso numero: è la procedura indicata sia dall’Agenzia delle Entrate sia da Aruba. Il pannello impedisce inoltre di cambiare sezionale e progressivo durante `Correggi e invia`.

Fonti ufficiali:

- [Agenzia delle Entrate — fatturazione elettronica e correzione dopo scarto](https://www1.agenziaentrate.gov.it/web_app_entrate/fatturazione_elettronica.html)
- [Aruba — correzione di fatture scartate](https://guide.aruba.it/soluzioni-fatturazione-elettronica/fe/fatture-inviate-ricevute-bozze/stati-fatture-elettroniche-inviate-sdi/correzione-fatture-notifiche-scarto-rifiuto)
- [Aruba — sezionale e progressivo](https://guide.aruba.it/soluzioni-fatturazione-elettronica/fe/fatture-documenti/dati-documento-clienti-prodotti-profilo-fiscale/campi-fattura-sezionale-progressivo)
- [Aruba — numerazione annuale dei sezionali](https://guide.aruba.it/soluzioni-fatturazione-elettronica/fe/impostazioni-e-cambio-dati-pannello/gestione-profilo/come-gestire-creare-sezionali)

## Validazione ripetibile

Lo schema ufficiale `FatturaPA_v1.2.2.xsd` è conservato senza modifiche insieme allo schema XMLDSig importato. SHA-256 dello schema FatturaPA: `cedaeece91d7a5334960143f0735ee020e6e94f33685b512f5899eb85c507e18`.

Il golden test verifica TD01 e TD04 anonimizzate, `RF14`, `N5`, i metodi di pagamento, i campi allineati al pannello e la conformità XSD offline, sia con sia senza i dati facoltativi del cedente. I test PostgreSQL verificano numerazione concorrente, permesso del solo titolare, hash stale, immutabilità, storage e approvazione in blocco.

## Gate di qualifica live differito

La prova controllata non blocca le attività locali successive: pagina sintetica, helper e controlli fail-closed sono verificati dal contratto candidato ricavato dall'audit read-only. Prima del Canary Production resta obbligatorio, soltanto dopo autorizzazione specifica, caricare il candidato anonimizzato nel pannello, leggere validazione e riepilogo, arrestarsi prima di `Invia` e rimuovere l'upload pendente. Ogni divergenza osservata deve correggere contratto, implementazione e test prima di chiudere il gate.
