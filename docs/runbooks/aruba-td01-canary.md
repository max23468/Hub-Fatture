# Invio pilota TD01 Aruba

Questa procedura governa un solo invio fiscale reale TD01. Non abilita l’uso ordinario, non
comprende TD04 e non consente di creare un documento appositamente per la prova.

## Condizioni di ingresso

- il candidato `1.0.0` non è pubblicato e i gate tecnici applicabili sono verdi sullo SHA esatto;
- l’immagine distribuita, lo schema e `/version` coincidono con il candidato;
- `ARUBA_SUBMISSION_ENABLED=false` è riletto dalla configurazione live;
- connessione API Aruba con identità verificata, non in pausa e inventario canonico aggiornato;
- nessun P0/P1, stato remoto incerto, conflitto o batch Aruba aperto;
- esiste una TD01 reale, legittima, approvata e necessaria operativamente.

Se una condizione manca, fermarsi prima di creare il permesso.

## Preparazione e dry-run

1. Massimo verifica nella preparazione destinatario, importo, data, numerazione e XML.
2. In `Documenti` crea un batch API contenente soltanto quella TD01.
3. Autorizza il dry-run Production riferito al batch e attende `Verifica Aruba superata`.
4. Rilegge il documento e il manifest. Qualunque variazione di revisione o hash invalida il
   percorso e impedisce l’invio.

## Autorizzazione e invio reale

L’azione `Autorizza un solo invio reale` è disponibile soltanto a `Massimo`, per un batch
Production con una sola TD01 e dry-run riuscito sullo stesso hash. La conferma crea un permesso di
quindici minuti legato ad ambiente, account, documento, revisione, batch, manifest e XML.

Il worker verifica nuovamente inventario, identità, connessione, arresti, documento, manifest,
hash e assenza di duplicati. Solo dopo avere caricato e verificato localmente l’XML e autenticato
l’account consuma atomicamente il permesso e registra il tentativo. Esegue quindi una sola chiamata
`POST /services/invoice/upload` con `dryRun=false`.

Un permesso scaduto prima del consumo non produce chiamate provider e richiede una nuova
autorizzazione esplicita. Un permesso consumato non può essere riaperto o sostituito.

## Readback e arresti

Dopo una risposta accettata, o dopo un esito incerto, viene richiesta subito una sincronizzazione
canonica dell’inventario. Il documento remoto viene collegato alla submission soltanto quando
account, ambiente e hash XML ufficiale coincidono. XML/P7M, PDF e notifiche disponibili restano
archiviati con la provenienza remota.

Timeout, risposta non valida, riavvio dopo il consumo o impossibilità di persistere l’esito portano
batch, submission e tentativo in `UNKNOWN_REMOTE_STATE`. Non è ammesso un secondo invio: si
prosegue esclusivamente con readback Aruba finché lo stato remoto è determinato oppure si apre un
incidente P0.

## Ricevuta di chiusura

Sul container web del candidato eseguire il report read-only compilato:

```sh
node build-server/operations/aruba-canary-readiness.js
```

Il report è sanitizzato: restituisce solo cardinalità, stati, presenza dei file e valore effettivo
dell’interruttore. La chiusura richiede `state=COMPLETE`, un solo permesso consumato, un solo
tentativo di invio, readback riuscito, almeno XML o P7M ufficiale, zero job attivi e
`submissionEnabled=false`.

Conservare fuori dal repository gli identificativi completi, gli hash e i documenti reali. Nel
record pubblico riportare soltanto commit, digest, schema, esito, cardinalità e riferimenti remoti
sanitizzati.

Il completamento dell’invio pilota non autorizza tag, GitHub Release, e-mail cliente o uso
Production ordinario.
