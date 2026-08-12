# Dominio ordini e preparazione fattura

## Capacità osservabili

- Migrazioni append-only per clienti, record sorgente, ordini, righe, identificativi fiscali completi di Paese, pagamenti e raggruppamenti interni.
- Import sintetico idempotente con validazione al confine, centesimi interi, sconti coerenti, anagrafiche incomplete verificabili, rifiuto atomico dei duplicati, dei Paesi extra UE e delle valute non supportate e protezione dagli aggiornamenti fuori ordine.
- Trigger globale a revisione ottimistica in Impostazioni, che rivaluta i soli ordini non raggruppati senza ricreare, sciogliere o riaprire preparazioni esistenti.
- Raggruppamento giornaliero concorrente per identità cliente prudente e data `Europe/Rome`, anche fra piattaforme diverse; una preparazione già approvata non assorbe ordini successivi dello stesso giorno.
- Identità non certa che non accorpa e mostra la corrispondenza possibile senza applicarla.
- Stato della preparazione derivato da un'unica espressione condivisa, con anomalie enumerate singolarmente e azione correttiva dichiarata per ciascuna.
- Correzione dell'anagrafica del destinatario prima dell'approvazione, con revisione ottimistica, audit di valore precedente e nuovo, motivo facoltativo e conservazione del valore importato sull'ordine.
- Composizione della preparazione: separazione di un ordine e aggiunta di un ordine compatibile, con l'ultimo ordine protetto dalla rimozione.
- Liste e dettagli autenticati di ordini e preparazioni fattura, paginati, con filtri per piattaforma, stato, data e pagamento, preparazione anticipata del singolo ordine e riepilogo operativo; la ricerca tratta i caratteri jolly come testo.
- Directory Clienti autenticata e paginata con viste Tutti/Da verificare, ricerca letterale per dati anagrafici, fiscali e riferimenti dei canali, riepilogo Shopify/eBay e dettaglio in sola consultazione di anagrafica corrente, origini, ordini, preparazioni e documenti collegati.
- Registro attività con vista `Da gestire` e cronologia ricercabile, filtrabile per tipo e attribuita all'account che ha agito.
- Archivio delle preparazioni non trasmesse, comprese quelle storiche rimaste senza ordini dopo una rettifica sorgente.
- Riconciliazione dei pagamenti sorgente senza cancellare gli incassi registrati manualmente.
- Audit atomico delle creazioni, assegnazioni, correzioni, separazioni e modifiche di configurazione.
- Accesso dati confinato nei moduli PostgreSQL di importazione, comandi, letture e preparazioni, con risultati di dettaglio tipizzati fino alle route.

## Gate ripetibile

Con il database test isolato attivo:

```sh
TEST_DATABASE_URL=postgres://hub_fatture:hub_fatture_test@127.0.0.1:5433/hub_fatture_test npm run check
```

Il gate verifica installazione e upgrade delle migrazioni, import e reimport, raggruppamento Shopify/eBay, cambio trigger che non ricrea né scioglie preparazioni, conflitto di revisione, correzione anagrafica che chiude la verifica e preserva gli identificativi fiscali, separazione e aggiunta di ordini, identità ambigua che non accorpa, riconciliazione della stessa identità cliente fra canali, ricerca e dettaglio Clienti, due import concorrenti che producono una sola preparazione, precisione sub-millisecondo dei timestamp, mancata propagazione della verifica fra ordini, rifiuto di Paesi extra UE e valute diverse da EUR, paginazione, audit, typecheck, build ed E2E browser delle superfici operative.

## Confini

OAuth, webhook e sincronizzazione provider appartengono ai connettori successivi. Documenti, righe fiscali del documento, comparatore e approvazione non sono anticipati; i raggruppamenti correnti contengono soltanto gli ordini sorgente compatibili e la correzione riguarda l’anagrafica del destinatario, non le righe della fattura.
