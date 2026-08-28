---
status: accepted
---

# Debian 13 Trixie Slim come base applicativa

Tutti gli stage dell’immagine applicativa usano l’immagine ufficiale `node:26.7.0-trixie-slim`, fissata per digest multi-arch e qualificata per `linux/arm64`. Node resta 26.7.0 e npm resta 12.0.2 negli stage che installano o costruiscono dipendenze. Il runtime non contiene npm, npx, TypeScript, Vite o altri strumenti di build.

I repository Debian e Debian Security puntano allo stesso snapshot immutabile. `libxml2-utils` è installato con pin esatto alla versione presente nello snapshot, tramite `apt-get install --no-install-recommends`; gli eventuali pacchetti di sistema con correzioni High/Critical richieste dalla scansione sono aggiornati con pin mirati nello stesso comando. Gli indici APT vengono eliminati nello stesso layer e la build non esegue un aggiornamento generale della distribuzione. `Acquire::Check-Valid-Until=false` è necessario perché gli indici storici di snapshot.debian.org devono restare utilizzabili dopo la scadenza ordinaria dei metadati; firme e keyring Debian non vengono disabilitati.

Dependabot conserva ecosistemi separati per Dockerfile e Docker Compose. Può quindi proporre l’aggiornamento del digest del tag Trixie approvato senza rendere mutabile la build e senza introdurre una base selezionabile.

## Conseguenze

La migrazione riguarda soltanto `app-web` e `app-worker`. La VPS condivisa resta Ubuntu; Caddy e PostgreSQL mantengono immagini, distribuzioni e comportamento correnti. Non sono previste migrazioni dati, modifiche a Compose Production o contatti con provider.

Il rollback è applicativo e immutabile: si riusa il digest precedente già attestato insieme al bundle operativo precedente, senza ricostruire l’immagine e senza down migration. Prima di eseguirlo, il runbook Production deve rileggere la ricevuta autorizzata e verificare digest, commit e schema; dopo l’avvio verifica health web, worker, connessioni, code e interruttore Aruba. Un rollback Production richiede autorizzazione separata.
