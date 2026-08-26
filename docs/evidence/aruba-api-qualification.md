# Qualifica API Aruba

## Stato osservato

Nel pannello Aruba Production dell'utenza Base è stata osservata una collaborazione attiva con:

- stato `Delegato`;
- permesso `Lettura` concesso;
- permessi web `Creazione/Modifica` e `Invio fatture` ancora concessi al momento della lettura;
- `WS Ciclo Attivo` concesso;
- `WS Ciclo Passivo` e `WS Comunicazioni Finanziarie` negati.

Il pannello presenta il collegamento nella superficie commercialista e usa la denominazione
`Supervisore`; non espone il Tier economico né dimostra da solo che le chiamate API siano
abilitate. Username, denominazione e identificativi fiscali del delegato non sono registrati in
questa evidenza. I due permessi web non sono necessari al probe API e possono essere rimossi
se l'accordo non prevede operazioni manuali dell'agenzia.

## Evidenza locale

Il probe usa esclusivamente gli host Aruba v2 ufficiali per autenticazione, `userInfo` e ricerca
delle fatture inviate. I contract test verificano:

- credenziali assenti dalla query string;
- host distinti DEMO/Production;
- identità fiscale fail-closed;
- arresto su account scaduto;
- assenza di qualunque endpoint di upload o invio.

## Prova Production del 26 agosto 2026

Il probe autenticato reale è terminato con esito positivo:

- identità dell'utenza Base verificata;
- account attivo e non scaduto;
- lettura del ciclo attivo autorizzata;
- una pagina di dimensione uno letta su un totale dichiarato di 13 gruppi nella finestra delle
  24 ore precedenti;
- nessun XML, dettaglio fattura, notifica o dato fiscale scaricato;
- nessun endpoint di upload o invio invocato.

## Gate ancora aperti

La prova qualifica autenticazione e lettura delle fatture inviate mediante delega. Non dimostra
ancora Tier assegnato e relativo conteggio economico, callback, download, invio, idempotenza o
riconciliazione completa. Il canale operativo Production non cambia fino alla qualifica delle
funzioni necessarie e alla chiusura dell'accordo.

## Qualifica paginata ancora aperta

Il probe locale e i contract test supportano al massimo due pagine da dieci gruppi, verificano la
coerenza di `numberOfElements`, `totalElements` e `totalPages` e scartano il contenuto senza stampa o
persistenza. Questa variante non è però ancora stata eseguita in Production: l'unica prova reale
osservata ha materializzato una voce su 13 gruppi dichiarati.

La prossima qualifica read-only dovrà quindi percorrere una finestra paginata entro un manifesto di
richieste limitate e confrontare separatamente gruppi API e documenti TD01/TD04 dell'inventario del
fallback. Fino a quella ricevuta, paginazione completa e semantica gruppo-documenti restano gate
aperti della qualifica API read-only.
