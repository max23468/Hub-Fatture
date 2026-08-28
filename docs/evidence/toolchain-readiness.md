# Readiness della toolchain

Questo documento descrive la baseline verificabile della toolchain. Non registra versioni, date o stato di avanzamento: per i valori correnti fanno fede esclusivamente i manifest e il lockfile dell’HEAD in esame.

## Fonti correnti

- `mise.toml`: runtime usati sul Mac e in CI.
- `package.json` e `package-lock.json`: dipendenze, motore e package manager.
- `Dockerfile` e `compose.yaml`: immagini, digest e strumenti di sistema.
- `doctor.config.json`: superficie analizzata da React Doctor.

Le immagini dichiarate devono includere `linux/arm64`. La base applicativa è l’immagine ufficiale Node Slim su Debian 13 Trixie, fissata per digest; i repository Debian e Debian Security usano lo stesso snapshot immutabile e i pacchetti richiesti dal runtime sono installati con pin esatti, inclusa la versione di `libxml2-utils` disponibile nello snapshot. Nessun documento corrente duplica i pin contenuti in queste fonti.

## Confini

- Le fixture sono sintetiche e usano esclusivamente domini `.invalid`, verificato da un test.
- Il preflight provider confronta identità attesa e osservata senza ricevere credenziali e resta fail-closed anche invocato da percorsi con spazi o symlink.
- Nessun accesso Production, deploy o release è implicato dai gate locali.
- La repository resta pubblicamente visibile ma proprietaria e non contiene chiavi private in chiaro.
- Il gate richiede rete per `npm audit` e un PostgreSQL di test raggiungibile: in sua assenza fallisce con un messaggio esplicito e non salta test.
- `typescript` resta nella chiusura di produzione del lockfile perché `@react-router/node` lo dichiara peer opzionale: è l'unica eccezione ammessa dalla policy toolchain e il layer finale dell'immagine Production deve rimuoverlo.
- `Acquire::Check-Valid-Until=false` è confinato alla build snapshot: gli indici `trixie-updates` e `trixie-security` scadono normalmente, mentre la riproducibilità richiede che lo snapshot storico resti installabile dopo la sua finestra di validità. Firma e keyring Debian restano verificati.

## Verifica ripetibile

`npm run check` verifica policy della toolchain, audit, formato, lint bloccante dai warning in su, tipi, runner server, test nativi, import, type stripping, React Doctor, build ed E2E. La policy toolchain confronta anche i pin di Node e npm fra manifest, `mise.toml` e `Dockerfile` e rifiuta strumenti di build nella chiusura di produzione. Lo stato corrente è il risultato del comando sull’HEAD esatto, non una ricevuta copiata in questo documento.

Lo smoke containerizzato richiede inoltre:

```sh
docker compose build app
docker compose up -d --wait app caddy
curl --fail http://localhost:8080/health
```

Il round-trip del blob `age` si verifica in streaming senza stampare il plaintext. Le verifiche GitHub e provider richiedono sempre un readback fresco dalla fonte autorevole.
