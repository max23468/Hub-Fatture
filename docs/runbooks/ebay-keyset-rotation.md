# Rotazione del keyset eBay

La rotazione sostituisce insieme client ID, client secret e RuName usati da Hub
Fatture. Il collegamento resta quello diretto già esposto in **Impostazioni**.
`EBAY_ACCOUNT_REFERENCE` identifica l'account venditore osservato dalla Identity
API e non deriva dal nome del keyset.

## Prerequisiti

Prima del fermo operativo devono risultare verificati:

- scope `sell.fulfillment.readonly` e `commerce.identity.readonly` disponibili
  sul keyset di destinazione;
- RuName dedicato a Hub Fatture con URL di accettazione e rifiuto
  `https://fatture.opik.net/integrations/ebay/callback`;
- endpoint Marketplace Account Deletion del keyset attivo su SyncBay e relay
  durevole configurato verso
  `https://fatture.opik.net/webhooks/ebay/account-deletion`;
- client ID, client secret e RuName disponibili nei rispettivi secret store;
- backup protetto del database e copia protetta della configurazione Production
  precedente.

La copia di rollback conserva come un'unica unità client ID, client secret e
RuName precedenti. I valori non devono comparire in log, prompt, screenshot o
file versionati.

## Cambio

1. Rileggere connessione eBay, ultimo aggiornamento, cursore e job aperti.
2. Fermare `app-worker`, lasciando disponibile `app-web` per il consenso.
3. Aggiornare insieme `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET` ed `EBAY_RUNAME`
   nella configurazione Production. Conservare `EBAY_ACCOUNT_REFERENCE=botCF`.
4. Ricreare `app-web` per caricare il nuovo client.
5. In **Impostazioni**, avviare il collegamento eBay e completare il consenso.
   La callback verifica l'account venditore prima di sostituire il refresh token
   cifrato.
6. Ricreare `app-worker` dopo che la connessione risulta collegata.
7. Eseguire una sincronizzazione in sola lettura e verificare avanzamento del
   cursore, assenza di duplicati, `buyer.taxIdentifier`, Trading `GetOrders` e
   `GetSellerTransactions`.
8. Inviare dal portale eBay la notifica Marketplace Account Deletion di prova e
   verificare la consegna firmata prima in SyncBay e poi in Hub Fatture.

## Arresto e rollback

Interrompere il cambio se l'identità venditore non coincide, il consenso non
restituisce un refresh token, gli scope sono rifiutati, una lettura ordini cambia
forma oppure la prova firmata del relay fallisce.

Per il rollback fermare nuovamente il worker, ripristinare insieme client ID,
client secret e RuName precedenti e ricreare `app-web`. Ripetere il consenso
OAuth con il precedente RuName, quindi ricreare `app-worker` e verificare
identità, cursore e una lettura ordini prima di riaprire la sincronizzazione.
Conservare il keyset precedente finché il nuovo percorso non supera il periodo
di osservazione concordato.
