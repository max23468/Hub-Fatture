# Audit Aruba e profilo FatturaPA

## Perimetro e metodo

Audit eseguito il 10 agosto 2026 nel pannello Aruba Production del titolare, tramite Chrome e in sola lettura. Non sono state modificate impostazioni, non è stata attivata la 2FA, non sono stati creati o caricati documenti e non è stato avviato alcun invio.

Sono stati analizzati un XML TD01 e un XML TD04 già accettati dallo SdI. I file originali sono rimasti fuori dal repository; le fixture versionate contengono soltanto identità, indirizzi, importi e riferimenti sintetici. Non sono state conservate schermate del pannello.

I due originali sono archiviati cifrati nel recovery kit locale di Hub Fatture e ne è stato verificato il round-trip byte per byte. Le copie temporanee in chiaro sono state eliminate.

## Profilo osservato

| Campo                           | Evidenza osservata                             | Profilo applicativo                                   |
| ------------------------------- | ---------------------------------------------- | ----------------------------------------------------- |
| Formato                         | `FPR12` in TD01 e TD04                         | `FPR12`                                               |
| Regime fiscale                  | XML accettati e Profilo fiscale Aruba          | `RF14`                                                |
| Natura del regime del margine   | Riga e riepilogo della TD01 accettata          | `N5`                                                  |
| Riferimento normativo           | XML accettati                                  | `Regime del margine Art. 36 41/95`                    |
| Tipo fattura                    | XML accettato                                  | `TD01`                                                |
| Tipo nota di credito            | XML accettato                                  | `TD04`                                                |
| Condizioni di pagamento         | XML accettati                                  | `TP02`                                                |
| Modalità fattura                | XML TD01 accettato                             | `MP08`                                                |
| Modalità nota                   | XML TD04 accettato                             | `MP05`                                                |
| Serie privati                   | Impostazioni Aruba, associata a fatture e note | `FPR`                                                 |
| Formato numero                  | Impostazioni e documenti accettati             | `FPR ####/##`                                         |
| Periodicità                     | Impostazioni Aruba                             | annuale, azzerata all’inizio dell’anno solare         |
| Destinatario senza canale       | TD04 accettata                                 | `0000000`; PEC soltanto quando presente               |
| Destinatario estero             | Specifica FatturaPA e regola pannello          | `XXXXXXX`                                             |
| Spedizione, sconti e trasporto  | nessun blocco separato nei campioni            | assorbiti nella riga semplificata e nel totale ordine |
| Arrotondamento, bollo, ritenuta | assenti nei campioni                           | non generati                                          |
| PDF e file ufficiali            | anteprima con download separati PDF, XML e P7M | download/readback Aruba, non PDF generato da HF       |

La TD04 storica contiene anche una riga al 22% estranea al perimetro 1.x, oltre alla riga `N5`. Il generatore non la replica: per le vendite comprese nel prodotto tutte le righe documentali applicano il profilo del margine `N5`. Sono invece conservate le differenze strutturali pertinenti alla nota: `TD04` e modalità `MP05`.

I nodi professionali vuoti aggiunti dal pannello e i dati bancari presenti soltanto nel campione storico sono opzionali e non vengono emessi. La validazione XSD dimostra che non sono necessari al documento prodotto.

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

Il golden test verifica TD01 e TD04 anonimizzate, `RF14`, `N5`, i metodi di pagamento e la conformità XSD offline. I test PostgreSQL verificano numerazione concorrente, permesso del solo titolare, hash stale, immutabilità, storage e approvazione in blocco.

## Gate ancora aperto

- Eseguire, soltanto dopo autorizzazione specifica, il caricamento del candidato anonimizzato nel pannello, leggere validazione e riepilogo, arrestarsi prima di `Invia` e rimuovere l'upload pendente.
