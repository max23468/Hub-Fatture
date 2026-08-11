# Evidenza Production OCI

## Capacità locali verificate

- account applicativi canonici `Massimo` e `Codex`, login case-insensitive, bootstrap atomico e vincoli database append-only;
- `can_approve=true` consentito soltanto a `Massimo`, con blocco server-side delle transizioni fiscali per `Codex`;
- immagine ARM64 unica per web e worker, runtime non-root con `xmllint` e senza TypeScript o tool di build;
- Compose Production con database interno, filesystem applicativo read-only, capability eliminate e kill switch Aruba fissato a `false`;
- Caddy con TLS automatico, header essenziali, limite body e log ruotati senza richieste contenenti query string;
- workflow manuale serializzato con candidato già in `main`, scansione, attestazione, gate `Production`, deploy per digest e readback;
- script versionati per preflight, deploy, ricevuta, backup cifrato, monitor e restore esplicito.

## Baseline infrastrutturale verificata

- istanza OCI ARM64, VNIC e hostname Ubuntu canonici `fatture-hub-vm`, con kernel e pacchetti correnti, aggiornamenti automatici, accesso SSH ristretto, `rpcbind` disabilitato e firewall su SSH/HTTP/HTTPS;
- `fatture.opik.net` risolto sull’IPv4 stabile della VPS, senza wildcard o IPv6, e preflight negativo che rifiuta un hostname diverso;
- plugin Compute Instance Monitoring attivo, topic `hub-fatture-operations`, sottoscrizione e-mail attiva e consegna di collaudo richiesta;
- quattro allarmi abilitati per metriche assenti, CPU, memoria e load average;
- dominio APM Always Free `hub-fatture-production` attivo; il monitor HTTP viene creato soltanto quando `/health` è live;
- bucket privato `hub-fatture-backups`, lifecycle di 30 giorni limitato a `hub-fatture/archive/` e copia `hub-fatture/current/` esclusa;
- dynamic group `hub-fatture-backup` ristretto alla sola VPS e policy senza lettura o cancellazione degli oggetti per il processo di backup;
- Environment GitHub `Production` limitato ai branch protetti, con `max23468` come unico reviewer e segreti SSH scoped.
- log applicativi ruotati dal driver locale Docker, access log Caddy ruotati nativamente e journal di sistema gestito da `systemd`.

## Ricevute remote

Questa sezione viene completata con ID OCI sanitizzati, commit, digest, schema, smoke, rollback e restore drill dopo il deploy autorizzato. Nessun valore segreto, IP, dato cliente o output SMTP integrale viene registrato.
