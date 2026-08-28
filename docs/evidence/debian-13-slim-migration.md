# Migrazione dell’immagine applicativa a Debian 13 Slim

## Perimetro e identità

La baseline locale è il commit `06efe903bf16e88a5afc0206d88e8d5d11735c23` di `origin/main`. La qualifica riguarda esclusivamente l’immagine condivisa da `app-web` e `app-worker`; non modifica VPS Ubuntu, Caddy, PostgreSQL, Compose Production, schema, storage, rete o provider.

| Voce              | Baseline                                                                                            | Candidato 0.3.92                                                                                  |
| ----------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Base Node         | `node:26.7.0-bookworm-slim@sha256:4db36457f406501e6f608802e5da617e5fbd0e80b75901b6a09de1ae5a667d32` | `node:26.7.0-trixie-slim@sha256:5758d367d7b4f48b73a9bb3530e687e47efb289f3b43f9c0450a25225ae0db5d` |
| Snapshot APT      | `20260824T000000Z`                                                                                  | `20260828T000000Z`                                                                                |
| `libxml2-utils`   | `2.9.14+dfsg-1.3~deb12u6`                                                                           | `2.12.7+dfsg+really2.9.14-2.1+deb13u3`                                                            |
| Correzioni mirate | nessuna aggiuntiva                                                                                  | `libssl3t64` e `openssl-provider-legacy` `3.5.7-1~deb13u2`                                        |

Il digest Trixie è l’indice OCI ufficiale corrente osservato e include il manifest `linux/arm64/v8`. Lo snapshot Debian e Debian Security usa lo stesso timestamp. Il primo snapshot candidato esponeva due finding High correggibili in OpenSSL ed è stato scartato; lo snapshot finale include le correzioni, installate con pin mirati senza `apt-get upgrade` generale.

## Benchmark ARM64 locale

Le due immagini sono state costruite sul builder Colima ARM64 nativo, senza pruning e senza fermare i container Development concorrenti. Dimensione e layer derivano da `docker image inspect`; memoria da `docker stats --no-stream` dopo health.

| Misura                                       | Baseline Bookworm | Candidato Trixie |           Confronto |
| -------------------------------------------- | ----------------: | ---------------: | ------------------: |
| Dimensione locale                            |  110.266.497 byte | 100.512.404 byte |               -8,8% |
| Dimensione mostrata da Docker                |            547 MB |           510 MB |              -37 MB |
| Layer RootFS                                 |                13 |               13 |           invariato |
| Tempo build osservato riuscito               |          206,55 s |         257,75 s | +24,8%, informativo |
| Health web, mediana di 3 avvii               |           4,084 s |          3,086 s |              -24,4% |
| Health web, media di 3 avvii                 |           5,556 s |          5,830 s |               +4,9% |
| Memoria web media                            |         85,17 MiB |        84,67 MiB |               -0,6% |
| Memoria worker a riposo, riferimento/mediana |         49,08 MiB |        51,75 MiB |           +2,67 MiB |
| Pacchetti runtime                            |                92 |               82 |                 -10 |

I tempi di build includono download da snapshot.debian.org e npm, senza normalizzazione della cache. Un tentativo candidato è fallito per `ECONNREFUSED` temporaneo dal registry npm e il retry è riuscito; l’aumento osservato non è accompagnato da crescita dell’immagine o dei pacchetti ed è attribuito a rete/cache, non al runtime. Anche gli avvii hanno mostrato un outlier per immagine; mediana, media e memoria non indicano una regressione materiale.

Web e worker usano un PostgreSQL dedicato su tmpfs, dati sintetici, filesystem applicativo read-only, `/tmp` e storage documenti su tmpfs, capability eliminate e `no-new-privileges`. I tre web hanno risposto a `/health`; migrazioni e riapplicazione idempotente hanno operato soltanto sul database di prova. Il worker è rimasto attivo e senza errori. Un `SIGTERM` diretto attraverso l’init di Compose è terminato autonomamente in 1,115 secondi con exit `0`. `docker stop` su Colima ha mostrato occasionalmente un timeout sia sulla baseline sia sul candidato; la prova diretta separa il comportamento applicativo dalla variabilità del daemon locale. La porta del PostgreSQL di test è parametrizzabile con default invariato, così il wrapper canonico può provare anche la corsia senza `TEST_DATABASE_URL` senza riusare un database concorrente.

## Ispezione runtime

| Controllo                               | Baseline                | Candidato               |
| --------------------------------------- | ----------------------- | ----------------------- |
| Debian                                  | 12.15                   | 13.6                    |
| glibc                                   | 2.36                    | 2.41                    |
| Node                                    | 26.7.0                  | 26.7.0                  |
| npm / npx                               | assenti                 | assenti                 |
| TypeScript / Vite / `@react-router/dev` | assenti                 | assenti                 |
| gcc / g++ / make                        | assenti                 | assenti                 |
| UID:GID                                 | `10001:10001`           | `10001:10001`           |
| `xmllint`                               | presente, libxml 2.9.14 | presente, libxml 2.9.14 |

Gli inventari `dpkg-query` completi sono stati registrati durante la qualifica: 92 pacchetti nella baseline e 82 nel candidato. Nel runtime candidato restano soltanto i pacchetti base Debian/Node, `libxml2`, `libxml2-utils`, `libssl3t64` e `openssl-provider-legacy`; non risultano compiler, npm/npx o strumenti di build. Le versioni dei pacchetti che determinano la qualifica sono riportate nelle tabelle e restano riproducibili dal Dockerfile e dall’immagine exact-SHA.

## Gate locali

- `npm run toolchain:check`, `npm run check:docs` (66/66) e la corsia standard (202/202 unit test, import, type stripping e build) sono verdi.
- Il wrapper canonico senza `TEST_DATABASE_URL` usa una porta PostgreSQL dedicata e passa 42/42 test DB; i contratti provider interamente sintetici passano 32/32 e React Doctor riporta 100/100.
- Chromium e WebKit passano entrambi 26/26 senza retry. Per eliminare i deadlock intermittenti fra suite, il reset E2E limita e ritenta soltanto i conflitti di lock sul database `_test`; non termina connessioni e non può operare su database non isolati. L’attesa delle sole aspettative E2E è fissata a 15 secondi per tollerare il carico della macchina condivisa, senza modificare asserzioni, timeout complessivi o retry.
- La build e lo smoke dell’immagine usano `linux/arm64`; il gate aggregato `npm run check`, la scansione bloccante e il preflight locale di pubblicazione devono riferirsi all’HEAD finale.

## Scansione e gate immagine

Trivy 0.74.0 è stato eseguito con la stessa policy della candidata Production: `ignore-unfixed=true`, severità `CRITICAL,HIGH`, exit code bloccante.

| Severità | Baseline totale / correggibile | Candidato totale / correggibile |
| -------- | -----------------------------: | ------------------------------: |
| Critical |                          6 / 0 |                           5 / 0 |
| High     |                         26 / 0 |                          12 / 0 |
| Medium   |                         75 / 0 |                          51 / 0 |
| Low      |                         75 / 0 |                          58 / 0 |
| Unknown  |                          6 / 0 |                           7 / 0 |

La policy bloccante termina con 0 finding correggibili High/Critical. I finding residui sono privi di versione corretta nello snapshot e restano soggetti a Dependabot, nuova scansione e riapertura quando Debian pubblica una correzione. La pipeline Production continua a costruire `linux/arm64`, scansionare il digest e attestarne la provenienza.

## Rollback non eseguito

La ricevuta pubblica della release `v0.3.91` collega il commit `acd7aa0fcdd5ad0c26930fa91cc9e0e673c55824`, il digest attestato `sha256:a2f18ff94d07b2580705432a6d726a595cc56a227859e3434aba944463b669ca` e lo schema `039_aruba_p7m_parity_normalization.sql`; il deployment GitHub exact-SHA ha registrato esito riuscito. Questa è evidenza pubblica storica, non un readback live della VPS eseguito durante la Fase 1.

Prima di un futuro deploy, il preflight deve rileggere la ricevuta Production autorizzata e confermare che commit e digest precedenti coincidano ancora. Il rollback riusa quel digest già attestato senza ricostruirlo e ripristina insieme il bundle Compose e Caddy precedente conservato dal runbook. La migrazione non cambia schema o dati e non richiede down migration.

Dopo un rollback autorizzato, verificare nell’ordine digest, commit, schema invariato, health web, worker, connessioni, code e `ARUBA_SUBMISSION_ENABLED=false`. In questa fase non è stato eseguito alcun rollback, deploy, accesso VPS, invio Aruba, scansione provider o e-mail reale.
