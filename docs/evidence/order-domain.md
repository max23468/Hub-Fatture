# Dominio ordini e preparazione fattura

## Capacità osservabili

- Migrazioni append-only per clienti, record sorgente, ordini, righe, identificativi fiscali completi di Paese, pagamenti e raggruppamenti interni.
- Import sintetico idempotente con validazione al confine, centesimi interi, sconti coerenti, anagrafiche incomplete verificabili, rifiuto atomico dei duplicati, dei Paesi extra UE e delle valute non supportate e protezione dagli aggiornamenti fuori ordine.
- Trigger globale a revisione ottimistica e rivalutazione dei soli ordini non raggruppati.
- Raggruppamento giornaliero concorrente per identità cliente prudente e data `Europe/Rome`, anche fra piattaforme diverse.
- Liste e dettagli autenticati di ordini e preparazioni fattura, filtri per piattaforma, stato, data e pagamento, preparazione anticipata del singolo ordine, riepilogo operativo e registro attività.
- Archivio delle preparazioni non trasmesse, comprese quelle storiche rimaste senza ordini dopo una rettifica sorgente.
- Riconciliazione dei pagamenti sorgente senza cancellare gli incassi registrati manualmente.
- Audit atomico delle creazioni, assegnazioni e modifiche di configurazione.
- Accesso dati confinato nei moduli PostgreSQL di importazione, comandi, letture e preparazioni, con risultati di dettaglio tipizzati fino alle route.

## Gate ripetibile

Con il database test isolato attivo:

```sh
TEST_DATABASE_URL=postgres://hub_fatture:hub_fatture_test@127.0.0.1:5433/hub_fatture_test npm run check
```

Il gate verifica installazione e upgrade delle migrazioni, import e reimport, raggruppamento Shopify/eBay, cambio trigger, conflitto di revisione, precisione sub-millisecondo dei timestamp, mancata propagazione della verifica fra ordini, rifiuto di Paesi extra UE e valute diverse da EUR, audit, typecheck, build ed E2E browser delle superfici operative.

## Confini

OAuth, webhook e sincronizzazione provider appartengono ai connettori successivi. Documenti, righe fiscali, modifiche della bozza e approvazione non sono anticipati; i raggruppamenti correnti contengono soltanto gli ordini sorgente compatibili.
