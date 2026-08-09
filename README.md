# Hub Fatture

Applicazione privata e single-tenant per importare ordini Shopify ed eBay, preparare documenti nel regime del margine e trasmetterli ad Aruba soltanto dopo approvazione esplicita.

Il progetto include toolchain riproducibile, database con migrazioni verificate, autenticazione amministrativa locale e dominio ordini/preparazione fattura con import sintetico idempotente, correzione dell'anagrafica del destinatario, composizione della preparazione e registro attività. La fonte canonica è il [Master Plan](docs/Hub_Fatture_MASTER_PLAN.md); l'indice della documentazione è in [docs/INDEX.md](docs/INDEX.md).

## Sviluppo locale

La toolchain è fissata in `mise.toml`. In un clone nuovo, autorizza il file prima di installarla:

```sh
mise trust
mise install
mise exec -- npm ci
mise exec -- npx playwright install chromium
```

Il gate canonico esegue test d'integrazione ed E2E su PostgreSQL reale, quindi richiede il database di test avviato e `TEST_DATABASE_URL` esportata:

```sh
docker compose --profile test up -d postgres-test
TEST_DATABASE_URL=postgres://hub_fatture:hub_fatture_test@127.0.0.1:5433/hub_fatture_test mise exec -- npm run check
```

Senza database il gate si ferma con un messaggio esplicito: nessun test viene saltato in silenzio. Il comando richiede rete per `npm audit`.

Il runtime Docker locale è Colima. La prima volta, abilitalo all'accesso e avvia lo stack Development in background:

```sh
brew services start colima
mise exec -- npm run dev:up
```

L'ambiente resta disponibile su `http://localhost:8080` anche fra sessioni di lavoro e riparte con Colima dopo il riavvio del Mac. Le modifiche al codice vengono caricate automaticamente; PostgreSQL e `node_modules` usano volumi persistenti. Il comando conserva nel Portachiavi macOS una sola chiave di cifratura Development e la riusa sia in Compose sia con Shopify CLI; il database persistente è raggiungibile dal solo Mac su `127.0.0.1:5432`. Il servizio `app-worker` gestisce webhook e sincronizzazioni periodiche. Usa `docker compose logs -f app app-worker` per seguire i processi e `docker compose stop` soltanto quando vuoi fermare esplicitamente l'ambiente. Non usare `docker compose down -v`, perché elimina i dati locali.

All'avvio lo stack applica le migrazioni. La prima configurazione usa `/setup`, crea atomicamente gli account fissi `matteo` e `codex` e richiede password di almeno 8 caratteri. Il token di bootstrap sintetico è dichiarato esclusivamente nel Compose locale; la password Development di `codex` resta nel Portachiavi macOS, mai nel repository. In ambienti condivisi i valori di `.env.example` devono provenire dal secret store.

L'ambiente locale accetta indifferentemente `localhost` e `127.0.0.1`; in Production vale soltanto l'origine dichiarata in `APP_BASE_URL`.

I connettori richiedono una chiave casuale di 32 byte codificata Base64 URL-safe, le credenziali dell'app Shopify dedicata e il keyset eBay `botCF`. I soli nomi delle variabili sono elencati in `.env.example`; token e secret restano nel secret store. La configurazione e i gate osservabili sono descritti nell'[evidenza connettori](docs/evidence/connectors.md).

Per sviluppare l'app Shopify dedicata sullo store `SyncBay Dev`, usa lo stesso database e la stessa chiave persistenti dello stack:

```sh
mise exec -- npm run dev:shopify
```

Prima di una futura scrittura remota, l'adapter del provider deve rilevare identità e target e passarli al confronto fail-closed:

```sh
mise exec -- npm run preflight:provider -- <provider-atteso> <account-atteso> <target-atteso> <provider-osservato> <account-osservato> <target-osservato>
```

Il comando non riceve né stampa credenziali.

## Licenza

Il codice è pubblicamente visibile ma proprietario. In assenza di un file `LICENSE`, non è concesso alcun diritto di uso, modifica o distribuzione.
