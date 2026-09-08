# Passaggio al keyset eBay SyncBay

SyncBay conserva l’unico RuName attivo e raccoglie il consenso OAuth del keyset
`botCF 2`. Hub Fatture continua a usare il proprio connettore eBay e riceve lo
stesso refresh token tramite un’operazione interna. Interfaccia, route e modello
di connessione di Hub Fatture restano invariati. `EBAY_ACCOUNT_REFERENCE`
identifica l’account venditore osservato dalla Identity API e conserva il valore
Production già verificato.

## Prerequisiti

Prima del fermo operativo devono risultare verificati:

- il token SyncBay comprende `commerce.identity.readonly`,
  `sell.inventory.readonly`, `sell.inventory`, `sell.fulfillment.readonly` e
  `commerce.notification.subscription`;
- il nuovo consenso è completato dal RuName SyncBay e il token risultante è
  utilizzabile da SyncBay;
- l’endpoint Marketplace Account Deletion SyncBay inoltra a Hub Fatture corpo e
  firma originali con retry durevole;
- `EBAY_CLIENT_ID` e `EBAY_CLIENT_SECRET` del keyset SyncBay sono pronti nel file
  secret Production di Hub Fatture;
- esistono un backup protetto del database e una copia protetta della
  configurazione Production precedente.

Il refresh token non deve comparire in argomenti di processo, variabili shell,
file temporanei, prompt, log o screenshot. Il processo autorizzato che lo legge
da SyncBay collega il proprio standard output direttamente allo standard input
del comando di installazione.

## Installazione

1. Rileggere connessione eBay, ultimo aggiornamento, cursore e job aperti.
2. Fermare `app-worker`.
3. Aggiornare insieme `EBAY_CLIENT_ID` ed `EBAY_CLIENT_SECRET` nel file secret
   Production, conservando `EBAY_ACCOUNT_REFERENCE` e `EBAY_RUNAME`.
4. Ricreare soltanto `app-web`, così l’operazione interna usa il nuovo client.
5. Dalla root Production, collegare direttamente la sorgente sicura del token al
   processo interno:

   ```sh
   <sorgente-token-syncbay> | docker compose -f compose.yaml \
     --env-file .env --env-file .deploy.env run --rm -T app-web \
     node build-server/operations/ebay-refresh-token-install.js
   ```

   L’operazione richiede il token solo su standard input, ottiene un access token
   con gli scope Hub Fatture, verifica che eBay li restituisca tutti, legge
   l’identità e confronta l’account con `EBAY_ACCOUNT_REFERENCE`. Solo dopo salva
   il refresh token cifrato e registra l’audit `PROVIDER_CONNECTED`. Un errore
   conserva la connessione precedente.

6. Ricreare `app-worker` dopo il messaggio di installazione riuscita.
7. Eseguire una sincronizzazione in sola lettura e verificare avanzamento del
   cursore, assenza di duplicati, `buyer.taxIdentifier`, Trading `GetOrders` e
   `GetSellerTransactions`.
8. Rileggere SyncBay sullo stesso keyset e verificare connessione, job e consegne
   del relay.

## Arresto e rollback

Interrompere il passaggio se manca uno scope, l’identità venditore non coincide,
il refresh grant fallisce o una lettura ordini cambia forma.

Se l’installazione fallisce, ripristinare client ID e client secret precedenti,
ricreare `app-web` e riavviare il worker dopo una lettura riuscita. Se il token è
stato installato ma il readback successivo fallisce, mantenere fermo il worker e
ripristinare database e configurazione dalla coppia di backup presa subito prima
del passaggio; verificare identità, cursore e una lettura ordini prima di
riaprire la sincronizzazione ordinaria.
