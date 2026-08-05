# Hub Fatture

Applicazione privata e single-tenant per importare ordini Shopify ed eBay, preparare documenti nel regime del margine e trasmetterli ad Aruba soltanto dopo approvazione esplicita.

Il progetto è in fase di scaffolding M0. La fonte canonica è il [Master Plan](docs/Hub_Fatture_MASTER_PLAN.md); l'indice della documentazione è in [docs/INDEX.md](docs/INDEX.md).

## Sviluppo locale

La toolchain è fissata in `mise.toml`. In un clone nuovo, autorizza il file prima di installarla; il gate canonico è:

```sh
mise trust
mise install
mise exec -- npm ci
mise exec -- npx playwright install chromium
mise exec -- npm run check
```

Lo stack locale containerizzato si avvia con `docker compose up` e risponde su `http://localhost:8080`.

Prima di una futura scrittura remota, l'adapter del provider deve rilevare identità e target e passarli al confronto fail-closed:

```sh
mise exec -- npm run preflight:provider -- <provider-atteso> <account-atteso> <target-atteso> <provider-osservato> <account-osservato> <target-osservato>
```

Il comando non riceve né stampa credenziali.

## Licenza

Il codice è pubblicamente visibile ma proprietario. In assenza di un file `LICENSE`, non è concesso alcun diritto di uso, modifica o distribuzione.
