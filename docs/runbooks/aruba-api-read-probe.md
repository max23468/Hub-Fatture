# Probe API Aruba in sola lettura

## Scopo

Verificare che l'utenza Aruba Base collegata in delega possa autenticarsi e leggere le fatture
inviate tramite le API v2 documentate. Il probe non contiene endpoint di upload, invio,
comunicazioni finanziarie o ciclo passivo.

## Precondizioni

- delega visibile come `Delegato` nel pannello Aruba;
- `WS Ciclo Attivo` concesso;
- identità fiscale attesa nota al titolare;
- autorizzazione esplicita per una lettura Production, oppure credenziali DEMO ottenute tramite
  lo specifico accreditamento Aruba;
- credenziali disponibili fuori dal repository, dalla chat e dai log.

L'ambiente DEMO usa credenziali proprie e temporanee. Non provare credenziali Production sugli
host DEMO.

## Inserimento temporaneo

Per la prima prova usare il comando interattivo: richiede i dati nel Terminale, disabilita l'eco
della password e li conserva soltanto nelle variabili del processo fino alla conclusione. Non
inserire valori nella riga di comando, in file `.env`, nella cronologia della shell o in output.

Il processo interno usa esclusivamente questi nomi:

- `ARUBA_API_ENVIRONMENT`, valore esplicito `DEMO` o `PRODUCTION`;
- `ARUBA_API_USERNAME`;
- `ARUBA_API_PASSWORD`;
- `ARUBA_API_EXPECTED_TAX_ID`.

## Esecuzione interattiva Production

Dal checkout qualificato:

```sh
mise exec -- npm run aruba:api:probe:interactive
```

La password non viene mostrata. Username e identità fiscale attesa sono visibili soltanto nel
prompt locale e non vengono ripetuti nell'output.

## Riutilizzo tramite Portachiavi macOS

La password può essere conservata nel Portachiavi macOS con servizio
`it.hub-fatture.aruba-api` e account uguale allo username Aruba. Non conservarla in `.env`, nel
repository o nella cronologia della shell. Dopo la registrazione iniziale, il probe può
recuperarla senza stamparla:

```sh
ARUBA_API_USERNAME='<username-base>' \
ARUBA_API_EXPECTED_TAX_ID='<piva-o-cf>' \
mise exec -- npm run aruba:api:probe:keychain
```

Il wrapper fallisce prima della rete se la voce non è presente. Il comando `security
find-generic-password ... -w` non deve essere eseguito direttamente in un Terminale, perché
stamperebbe la password.

Il probe esegue soltanto:

1. `POST /auth/signin`, con le credenziali nel body form HTTPS;
2. `GET /auth/userInfo`, verificando P.IVA/codice fiscale atteso e account non scaduto;
3. `GET /api/v2/invoices-out`, al massimo due pagine da dieci gruppi nello stesso intervallo di
   24 ore. Il probe verifica la coerenza dei metadati di paginazione, scarta il contenuto e stampa
   soltanto i conteggi. Se la finestra richiede più di due pagine, dichiara la copertura incompleta
   senza proseguire automaticamente.

L'output contiene ambiente, esito della verifica e soli conteggi. Non contiene username, P.IVA,
token, password, destinatari, importi o nomi file.

## Criteri di arresto

Arrestarsi senza tentare endpoint alternativi quando:

- autenticazione o permesso Web Service sono rifiutati;
- l'identità fiscale non coincide;
- l'account risulta scaduto;
- Aruba restituisce uno schema inatteso, un rate limit o uno stato non gestito;
- la delega risulta diversa da quella osservata nel pannello.

Un probe riuscito con `completeWindowRead: true` qualifica autenticazione, lettura del ciclo
attivo e paginazione della sola finestra osservata. Non prova ancora Tier, conteggio economico,
callback, download massivi, invio, idempotenza, semantica gruppi-documenti o riconciliazione
completa.
