# Evidenza M0

Stato: verifiche locali completate il 5 agosto 2026; chiusura GitHub in corso.

## Pin risolti

- Node.js 26.5.0 stabile e npm 12.0.2.
- React 19.2.8, React Router 8.3.0, Vite 8.2.0 e TypeScript 7.0.2.
- Node `sha256:2d49d876e96237d76de412761cf05dbfe5aee325cc4406a4d41d5824c5bb8beb`.
- PostgreSQL `sha256:80630f83606d8db77d30b3851b16a9f78be2d0d4dda6f7b82a1fdca5ebe3acba`.
- Caddy `sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d`.

I tre manifest includono `linux/arm64`. Manifest e lockfile sono le fonti canoniche dei pin M0.

## Confini

- Le fixture sono sintetiche e usano esclusivamente domini `.invalid`.
- Il preflight provider confronta identità attesa e osservata senza ricevere credenziali.
- Nessun accesso Production, deploy o release è compreso in M0.
- Brand Foundation e migrazioni/database applicativi appartengono a M1.

## Verifica

- `mise exec -- node --version`: `v26.5.0`.
- `mise exec -- npm --version`: `12.0.2`.
- `npm outdated`: nessuna dipendenza diretta arretrata.
- `npm audit --audit-level=high`: zero vulnerabilità.
- `mise exec -- npm run check`: 20 test Node, smoke import/type stripping, lint, formato, typecheck, build e uno smoke Chromium superati.
- `docker compose up --wait` su Mac ARM64: PostgreSQL, app e Caddy healthy; risposta HTTP verificata; risorse di prova rimosse.
- round-trip `age`: blob decifrato in streaming identico al plaintext locale; plaintext assente da indice e cronologia Git.
- repository GitHub pubblica proprietaria con Issues e Discussions disabilitati, ruleset `main`, Private Vulnerability Reporting, release immutabili, vulnerability alert e security update attivi.
- allowlist GitHub Actions limitata alle Action GitHub e ai soli pin completi di Dependabot metadata e Mise usati dai workflow.

Restano da collegare la PR, i check sul suo HEAD e la prova remota dell'auto-merge Dependabot. La prova non viene simulata degradando intenzionalmente uno dei pin stabili correnti.
