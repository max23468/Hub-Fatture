# Inventario segreti

Questo documento elenca solo nomi logici e destinazioni. Non inserire valori, prefissi o fingerprint.

| Nome logico                                | Ambiente                 | Destinazione                                              | Owner    | Rotazione / revoca                                                    |
| ------------------------------------------ | ------------------------ | --------------------------------------------------------- | -------- | --------------------------------------------------------------------- |
| `ADMIN_BOOTSTRAP_TOKEN`                    | Development / Production | file secret applicativo                                   | titolare | ruotare dopo il bootstrap e ridistribuire app                         |
| `DATABASE_URL`                             | Development / Production | configurazione processo app                               | titolare | ruotare ruolo/password PostgreSQL e riavviare app                     |
| Password account `matteo`                  | Development / Production | password manager del titolare, voce distinta per ambiente | titolare | ruotare l’hash applicativo e revocare le sessioni esistenti           |
| Password account `codex`                   | Development / Production | Portachiavi macOS, voce distinta per ambiente             | titolare | ruotare l’hash applicativo, revocare le sessioni e aggiornare la voce |
| VPS SSH key                                | Production               | plaintext solo sul Mac; blob `age` nel repository         | titolare | sostituire authorized key e blob cifrato, poi verificare round-trip   |
| `CREDENTIALS_ENCRYPTION_KEY`               | Development / Production | Portachiavi macOS / file secret applicativo               | titolare | ruotare cifrando nuovamente le credenziali provider                   |
| `SHOPIFY_API_KEY`                          | Development / Production | configurazione processo app                               | titolare | ruotare nel Dev Dashboard e ridistribuire app                         |
| `SHOPIFY_API_SECRET`                       | Development / Production | Portachiavi macOS / file secret applicativo               | titolare | ruotare nel Dev Dashboard, ridistribuire e ricollegare                |
| Token accesso Shopify                      | Development / Production | tabella `connections`, cifrato                            | app      | revocare o reinstallare l'app                                         |
| `EBAY_CLIENT_ID`                           | Sandbox / Production     | Portachiavi macOS / file secret applicativo               | titolare | ruotare il keyset e ridistribuire                                     |
| `EBAY_CLIENT_SECRET`                       | Sandbox / Production     | Portachiavi macOS / file secret applicativo               | titolare | ruotare il keyset, ridistribuire e ricollegare                        |
| `EBAY_RUNAME`                              | Sandbox / Production     | Portachiavi macOS / configurazione processo app           | titolare | aggiornare il redirect e ripetere OAuth                               |
| Token refresh eBay                         | Sandbox / Production     | tabella `connections`, cifrato                            | app      | revocare il consenso e ricollegare                                    |
| `EBAY_ACCOUNT_DELETION_ENDPOINT_URL`       | Production               | file secret FiscalBay                                     | titolare | aggiornare l'endpoint canonico e verificarne la challenge             |
| `EBAY_ACCOUNT_DELETION_VERIFICATION_TOKEN` | Production               | file secret FiscalBay                                     | titolare | ruotare il token e ripetere la challenge                              |
| `HUB_FATTURE_EBAY_ACCOUNT_DELETION_URL`    | Production               | file secret FiscalBay                                     | titolare | aggiornare il relay e ripetere la prova firmata end-to-end            |

Il bootstrap non registra token o password nei log. L’app conserva soltanto gli hash `scrypt`; le password restano nei rispettivi depositi locali e non entrano nel repository. Finché non esiste una funzione applicativa di rotazione, il cambio password è una procedura amministrativa controllata, non un’azione disponibile nel frontend. Il ripristino Production richiede il recovery kit separato dalla VPS, un readback applicativo e un collaudo completo prima dell’attivazione.
