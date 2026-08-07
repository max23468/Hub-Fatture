# Readiness della toolchain

Questo documento descrive la baseline verificabile della toolchain. Non registra versioni, date o stato di avanzamento: per i valori correnti fanno fede esclusivamente i manifest e il lockfile dell’HEAD in esame.

## Fonti correnti

- `mise.toml`: runtime usati sul Mac e in CI.
- `package.json` e `package-lock.json`: dipendenze, motore e package manager.
- `Dockerfile` e `compose.yaml`: immagini, digest e strumenti di sistema.
- `doctor.config.json`: superficie analizzata da React Doctor.

Le immagini dichiarate devono includere `linux/arm64`. Nessun documento duplica i pin contenuti in queste fonti.

## Confini

- Le fixture sono sintetiche e usano esclusivamente domini `.invalid`.
- Il preflight provider confronta identità attesa e osservata senza ricevere credenziali.
- Nessun accesso Production, deploy o release è implicato dai gate locali.
- La repository resta pubblicamente visibile ma proprietaria e non contiene chiavi private in chiaro.

## Verifica ripetibile

`npm run check` verifica policy della toolchain, audit, formato, lint, tipi, runner server, test nativi, import, type stripping, React Doctor, build ed E2E. Lo stato corrente è il risultato del comando sull’HEAD esatto, non una ricevuta copiata in questo documento.

Lo smoke containerizzato richiede inoltre:

```sh
docker compose build app
docker compose up -d --wait app caddy
curl --fail http://localhost:8080/health
```

Il round-trip del blob `age` si verifica in streaming senza stampare il plaintext. Le verifiche GitHub e provider richiedono sempre un readback fresco dalla fonte autorevole.
