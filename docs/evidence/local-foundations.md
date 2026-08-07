# Fondazioni locali

Questo documento descrive capacità e gate delle fondazioni applicative. Evita ricevute legate a un branch, una data o un conteggio di test: lo stato corrente si ricava dal codice e dalla CI dell’HEAD esatto.

## Capacità

- React Router protetto da due account amministrativi nominali e fissi, `matteo` e `codex`.
- Password con minimo 8 caratteri e hash `scrypt`; session token e CSRF token hashati in PostgreSQL.
- Setup iniziale vincolato a token, rate limit login atomico per username, audit e cookie sicuri in Production.
- Production rifiuta una base URL priva di HTTPS; Caddy applica un limite globale e i form un limite più stretto prima del parsing, con timeout, verifica same-origin e codici errore stabili.
- Migrazioni SQL append-only con advisory lock e checksum; rimozione o modifica di file applicati bloccata.
- Impostazioni con revisione ottimistica e readback completo.
- Compose locale con PostgreSQL non pubblicato e database test isolato su loopback.
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
