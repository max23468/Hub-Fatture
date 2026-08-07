# Registro errori

La fonte eseguibile è `src/errors.ts`. I codici iniziali coprono autenticazione, conflitti e limiti HTTP; i messaggi provider verranno aggiunti soltanto con i rispettivi connettori.

| Codice                     | Categoria             | Retry automatico | Azione                               |
| -------------------------- | --------------------- | ---------------- | ------------------------------------ |
| `AUTH_INVALID_CREDENTIALS` | AUTH permanente       | no               | correggere username o password       |
| `AUTH_PASSWORD_POLICY`     | VALIDATION permanente | no               | usare da 8 a 128 caratteri           |
| `AUTH_RATE_LIMITED`        | AUTH temporaneo       | no               | attendere la finestra indicata       |
| `AUTH_SETUP_DISABLED`      | CONFLICT permanente   | no               | usare uno degli account esistenti    |
| `AUTH_INVALID_SETUP_TOKEN` | AUTH permanente       | no               | verificare il secret locale          |
| `CONFLICT_REVISION`        | CONFLICT              | no               | rileggere e ripetere la modifica     |
| `INVALID_CONTENT_TYPE`     | VALIDATION permanente | no               | inviare il formato previsto          |
| `REQUEST_BODY_TOO_LARGE`   | VALIDATION permanente | no               | ridurre il payload                   |
| `REQUEST_ORIGIN_INVALID`   | AUTH permanente       | no               | usare l’origine configurata dell’app |
| `REQUEST_TIMEOUT`          | NETWORK transitorio   | no per mutazioni | ripetere soltanto dopo readback      |
| `UNKNOWN`                  | UNKNOWN               | no               | diagnosticare con request ID         |
