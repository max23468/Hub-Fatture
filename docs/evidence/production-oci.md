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
- dominio APM Always Free `hub-fatture-production` attivo con monitor HTTP `hub-fatture-health` ogni 6 minuti da Milano;
- bucket privato `hub-fatture-backups`, lifecycle di 30 giorni limitato a `hub-fatture/archive/` e copia `hub-fatture/current/` esclusa;
- dynamic group `hub-fatture-backup` ristretto alla sola VPS e policy limitata alla creazione e al readback degli oggetti cifrati, alla pubblicazione sul topic e all’esecuzione di Run Command; la VPS non può cancellare backup;
- Environment GitHub `Production` limitato ai branch protetti, con `max23468` come unico reviewer e segreti SSH scoped.
- log applicativi ruotati dal driver locale Docker, access log Caddy ruotati nativamente e journal di sistema gestito da `systemd`.

## Ricevute remote

Ambiente `Production`, regione `eu-milan-1`, istanza OCI con suffisso `v6almouq`, hostname `fatture-hub-vm`. Nessun valore segreto, IP, dato cliente o output SMTP integrale è registrato.

### Deploy e readback

- workflow manuale [Production 31534190604](https://github.com/max23468/Hub-Fatture/actions/runs/31534190604) concluso con successo dopo approvazione dell’Environment;
- commit `f875b578447cb42f28873f336d8c72f6faeb6db3`, digest ARM64 `sha256:0eb76e32fb64ca923135fd98de3e768c2321692400b7f539f1063ce1ca5e310b`, attestazione verificata prima del pull e stessa immagine riletta su web e worker;
- versione applicativa `0.0.0`, schema `015_canonical_account_names.sql`, `ARUBA_SUBMISSION_ENABLED=false`, ricevuta e health `ok`;
- smoke autenticato finale del `2026-08-11T21:12:42Z`: `mAsSiMo` e `CODEX` accedono rispettivamente come `Massimo` titolare e `Codex` operatore; menu, profilo e audit usano i nomi canonici e solo `Massimo` espone il permesso fiscale;
- readback database: due soli account, `Massimo` con `can_approve=true` e `Codex` con `can_approve=false`; indice univoco case-insensitive e vincolo che rifiuta il privilegio su `Codex` verificati anche nel restore isolato.

### Rollback e ritorno

- backup pre-rollback completato, quindi rollback reale al commit `3eccac2a18f53b5bcd38aa7abd7ab4be39666afa` e digest `sha256:8ed61a4a81480d06e280f89385c8d71d45bcd1f2216ba507a06deb0dba32f77a`;
- readback rollback del `2026-08-11T21:00:38Z`: schema `015_canonical_account_names.sql`, kill switch `false`, health verde, web e worker sul digest precedente e login riuscito per entrambi gli account;
- ritorno allo stesso commit e digest correnti verificato alle `2026-08-11T21:01:45Z`, senza down migration e con gli stessi gate di health, schema e kill switch.

### Backup e restore drill

- backup corrente cifrato completato alle `2026-08-11T21:02:45Z`, oggetto archivio `hub-fatture/archive/2026/08/11/20260811T210258Z-f875b578447cb42f28873f336d8c72f6faeb6db3.tar.age`, dimensione `143592` byte e SHA-256 riletto da Object Storage;
- copia `current` scaricata in `~/HubFatture-Backups/` con permessi riservati e verificata per dimensione e checksum prima della decifratura;
- `scripts/restore.sh` eseguito sul Mac con l’identità del recovery kit, target filesystem nuovo e PostgreSQL isolato; manifest, 15 migrazioni, 2 account e 15 eventi di audit riletti;
- il backup non contiene ancora documenti fiscali o file documento, coerentemente con una Production senza ordini reali; directory e conteggio zero coincidono nel restore;
- la stessa immagine Production è partita sul database ripristinato: health verde, login case-insensitive di entrambi gli account, nomi canonici e rifiuto database di `can_approve=true` per `Codex` verificati; target, container e database temporanei sono poi stati rimossi.

### OCI e sistema operativo

- istanza `VM.Standard.A1.Flex` portata a 4 OCPU e 24 GB, massimo Ampere Always Free disponibile nel tenancy; boot volume mantenuto a 47 GB per non consumare senza necessità il plafond storage condiviso con le altre VPS;
- riavvio conseguente verificato: kernel Oracle corrente, nessun pacchetto APT o snap pendente e nessun altro riavvio richiesto;
- agent OCI, Compute Instance Monitoring, OS Management Hub, Block Volume Management, Bastion e Run Command attivi; Run Command collaudato dopo aver aggiunto il permesso minimo al dynamic group;
- allarmi `hub-fatture-metrics-absent`, `hub-fatture-cpu-high`, `hub-fatture-memory-high` e `hub-fatture-load-high` riletti `OK`;
- monitor APM `hub-fatture-health` abilitato, risposta HTTP `200`, metrica Availability/Success `1` e Failure `0`;
- timer `hub-fatture-backup` e `hub-fatture-monitor` attivi dopo il riavvio; monitor locale sano e container applicativi ripartiti automaticamente.

## Limiti osservati

Questa è una pubblicazione tecnica della Production, non il go-live: nessuna GitHub Release, nessun invio Aruba, nessuna e-mail cliente e nessun ordine reale sono stati prodotti. Il canary e la qualifica sul pannello Aruba restano ai gate successivi del Master Plan.
