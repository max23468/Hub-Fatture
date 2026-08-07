# Inventario segreti

Questo documento elenca solo nomi logici e destinazioni. Non inserire valori, prefissi o fingerprint.

| Nome logico               | Ambiente                 | Destinazione                                              | Owner    | Rotazione / revoca                                                    |
| ------------------------- | ------------------------ | --------------------------------------------------------- | -------- | --------------------------------------------------------------------- |
| `ADMIN_BOOTSTRAP_TOKEN`   | Development / Production | file secret applicativo                                   | titolare | ruotare dopo il bootstrap e ridistribuire app                         |
| `DATABASE_URL`            | Development / Production | configurazione processo app                               | titolare | ruotare ruolo/password PostgreSQL e riavviare app                     |
| Password account `matteo` | Development / Production | password manager del titolare, voce distinta per ambiente | titolare | ruotare l’hash applicativo e revocare le sessioni esistenti           |
| Password account `codex`  | Development / Production | Portachiavi macOS, voce distinta per ambiente             | titolare | ruotare l’hash applicativo, revocare le sessioni e aggiornare la voce |
| VPS SSH key               | Production               | plaintext solo sul Mac; blob `age` nel repository         | titolare | sostituire authorized key e blob cifrato, poi verificare round-trip   |

Il bootstrap non registra token o password nei log. L’app conserva soltanto gli hash `scrypt`; le password restano nei rispettivi depositi locali e non entrano nel repository. Finché non esiste una funzione applicativa di rotazione, il cambio password è una procedura amministrativa controllata, non un’azione disponibile nel frontend. Il ripristino Production richiede il recovery kit separato dalla VPS, un readback applicativo e un collaudo completo prima dell’attivazione.
