# Qualifica API Aruba

## Stato osservato

Nel pannello Aruba Production dell'utenza Base è stata osservata una collaborazione attiva con:

- stato `Delegato`;
- permesso `Lettura` concesso;
- permessi web `Creazione/Modifica` e `Invio fatture` ancora concessi al momento della lettura;
- `WS Ciclo Attivo` concesso;
- `WS Ciclo Passivo` e `WS Comunicazioni Finanziarie` negati.

Il pannello presenta il collegamento nella superficie commercialista e usa la denominazione
`Supervisore`; non dimostra da solo che le chiamate API siano abilitate. Username, denominazione e
identificativi fiscali del delegato non sono registrati in questa evidenza. I due permessi web non
sono necessari al probe API e possono essere rimossi se l'accordo non prevede operazioni manuali
dell'agenzia.

## Evidenza locale

Il probe usa esclusivamente gli host Aruba v2 ufficiali per autenticazione, `userInfo` e ricerca
delle fatture inviate. I contract test verificano:

- credenziali assenti dalla query string;
- host distinti DEMO/Production;
- identità fiscale fail-closed;
- arresto su account scaduto;
- assenza di qualunque endpoint di upload o invio.

Il contratto locale distingue ora gruppi API e documenti Aruba, accetta gruppi con zero, uno o più
documenti, tipizza TDxx e i dieci stati documentati, normalizza gli stati mediante il contratto
canonico condiviso e rifiuta etichette sconosciute. La fixture sintetica copre TD01, TD04, un altro
tipo, gruppo vuoto e gruppo multiplo. Il probe restituisce soltanto conteggi sanitizzati.

La qualifica ha inoltre corretto la semantica condivisa di `Errore elaborazione`: Aruba lo descrive
come problema tecnico nell’invio, quindi non costituisce uno scarto fiscale confermato e viene
classificato `UNKNOWN` in modo fail-closed.

La documentazione provider corrente qualifica inoltre i limiti dichiarati: una autenticazione al
minuto per IP, dodici ricerche di fatture inviate al minuto per IP, dodici ricerche di notifiche al
minuto per IP, finestra massima di 48 ore e risposta `429` al superamento. Il probe usa una finestra
di 24 ore, pagine da dieci e al massimo due pagine senza retry automatico.

## Prova Production del 26 agosto 2026

Il primo probe autenticato reale è terminato con esito positivo:

- identità dell'utenza Base verificata;
- account attivo e non scaduto;
- lettura del ciclo attivo autorizzata;
- una pagina di dimensione uno letta su un totale dichiarato di 13 gruppi nella finestra delle
  24 ore precedenti;
- nessun XML, dettaglio fattura, notifica o dato fiscale scaricato;
- nessun endpoint di upload o invio invocato.

Una seconda lettura, autorizzata con manifesto limitato, ha poi chiuso la paginazione della finestra
osservata tra `2026-08-25T20:41:44.431Z` e `2026-08-26T20:41:44.431Z`:

- identità e account nuovamente verificati;
- tre richieste HTTP effettive: autenticazione, `userInfo` e una sola pagina `invoices-out`;
- 8 gruppi restituiti su 8 dichiarati, con `completeWindowRead: true`;
- 8 documenti: tutti i gruppi avevano cardinalità uno;
- 8 TD01, zero TD04 e zero tipi diversi;
- 2 documenti `DELIVERED` e 6 `NOT_DELIVERED`; nessuno stato sconosciuto;
- nessun dettaglio, XML, P7M, PDF, notifica o download richiesto;
- nessuna persistenza canonica e nessuna mutazione Aruba.

La prova qualifica paginazione completa e distinzione gruppo-documento per la finestra osservata. La
forma zero/uno/molti resta coperta dal contratto ufficiale e dalle fixture; la finestra reale ha
osservato soltanto gruppi singoli.

## Confini della prova

La prova qualifica autenticazione e lettura delle fatture inviate mediante delega. Non dimostra
ancora disponibilità reale dei file, callback, download, invio, idempotenza o riconciliazione
completa. Tier e contatori del Premium delegato sono responsabilità contrattuali del provider e non
costituiscono requisiti o gate di Hub Fatture. Il client deve soltanto rispettare i limiti documentati
degli endpoint e gestire `429` o blocchi provider in modo fail-closed. Il forfait comprensivo dell’uso
API è una decisione consolidata. Il canale operativo Production non cambia: backfill, file reali e
autorità inbound appartengono alla successiva sincronizzazione; callback e capacità mutative
appartengono alle fasi successive.

## Confronto iniziale con il fallback

Il confronto iniziale della qualifica è stato eseguito sulla vista Production esistente senza avviare una nuova
scansione, importare dati o persistere gli aggregati osservati. Ha confermato che la finestra API usa
la data di creazione mentre il fallback espone la data documento: i due insiemi non sono una
popolazione comparabile e i soli conteggi non dimostrano parità.

Il comparatore shadow locale fallisce chiuso: accetta soltanto ID remoti nello stesso namespace
oppure identità fiscali complete e univoche, verifica le invarianti e restituisce soli conteggi
sanitizzati. La parità su snapshot allineati è il gate della sincronizzazione inbound, insieme al
backfill e all’inventario canonico; non viene anticipata né simulata nella qualifica API.

## Esito della qualifica

La milestone è completata: manifesto e probe read-only sono chiusi, identità e ambiente sono
verificati, la paginazione della finestra osservata è completa, gruppi e documenti sono distinti,
stati, forme di file, notifiche, limiti ed errori sono contrattualizzati su documentazione ufficiale e fixture,
e il confronto iniziale ha classificato la differenza temporale senza falsi match. Non sono stati
eseguiti download, persistenza canonica, upload, dry-run o invii.
