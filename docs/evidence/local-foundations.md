# Fondazioni locali

Questo documento descrive capacità e gate delle fondazioni applicative. Evita ricevute legate a un branch, una data o un conteggio di test: lo stato corrente si ricava dal codice e dalla CI dell’HEAD esatto.

## Capacità

- React Router protetto da due account amministrativi nominali e fissi, `Massimo` e `Codex`; il login è case-insensitive e la forma canonica resta stabile in interfaccia e audit.
- Password con minimo 8 caratteri e hash `scrypt` con i parametri di costo scritti nell’hash; session token e CSRF token hashati in PostgreSQL, entrambi i cookie `HttpOnly`.
- Setup iniziale vincolato a token, rate limit login atomico per username, audit e cookie sicuri in Production.
- Il rate limit del login ferma davvero le verifiche, e lo fa per origine: chi attacca blocca sé stesso, non il titolare che arriva da un altro indirizzo. Una soglia molto più alta per username resta come argine agli attacchi distribuiti. L’origine deriva dall’ultimo valore di `X-Forwarded-For`, l’unico che il client non può falsificare dietro l’unico ingresso Caddy; in accesso diretto tutte le richieste condividono un secchio. L’`ip_hash` vive quanto la finestra e viene rimosso dalla potatura di ogni login. Ogni episodio di blocco lascia un evento critico, uno solo, deduplicato sull’evento già registrato e non su un contatore che sotto concorrenza può scavalcare la soglia.
- Production rifiuta una base URL priva di HTTPS; Caddy applica un limite globale e i form un limite più stretto prima del parsing, con timeout, verifica same-origin e codici errore stabili anche senza `Content-Length` dichiarato.
- Ogni azione passa da un unico traduttore di errori: lo status del registro sopravvive al framework invece di degradare a 500. Le risposte dichiarano `frame-ancestors`, `nosniff` e `Referrer-Policy`.
- Sessioni scadute e tentativi fuori finestra eliminati da una potatura guidata dal tempo, non dall’arrivo del login successivo.
- Migrazioni SQL append-only con advisory lock e checksum; rimozione o modifica di file applicati bloccata. Il cambio di formato degli hash rimuove gli account con una migrazione e riapre `/setup`, invece di conservare un percorso di verifica legacy che lascerebbe esclusa un’installazione esistente.
- Impostazioni con revisione ottimistica e readback completo.
- Compose locale con PostgreSQL non pubblicato e database test isolato su loopback, azzerato prima di ogni esecuzione E2E.
- Brand Foundation approvata, temi Sistema/Chiaro/Scuro, token semantici, Lucide, target interattivi minimi e shell responsive.
- Catalogo italiano, glossario e inventario segreti senza valori.

## Gate ripetibile

Con il database test isolato attivo:

```sh
TEST_DATABASE_URL=postgres://hub_fatture:hub_fatture_test@127.0.0.1:5433/hub_fatture_test npm run check
```

Il gate include audit dipendenze, formato, lint, typecheck, test nativi, migrazioni, sicurezza HTTP, React Doctor, build client/server ed E2E di setup, accesso con entrambi gli account e persistenza del tema. Il numero dei test non viene duplicato qui.

Lo smoke Docker verifica PostgreSQL, applicazione, Caddy, `/health`, pagina di login e versione npm dell’immagine. La verifica visiva copre temi chiaro e scuro, desktop e mobile, navigazione da tastiera e assenza di scorrimento orizzontale.

## Confini

Ricerca, destinazioni aggiuntive della navigazione e contenuti operativi vengono implementati soltanto insieme ai dati e ai flussi reali che li usano. Nessun contenitore vuoto anticipa funzionalità future.
