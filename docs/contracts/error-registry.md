# Registro errori

La fonte eseguibile è `src/errors.ts`. Ogni azione passa da `app/action.ts`, che traduce l’errore nello status dichiarato qui invece di lasciarlo degradare a 500.

| Codice                           | Categoria             | Retry automatico | Azione                                |
| -------------------------------- | --------------------- | ---------------- | ------------------------------------- |
| `AUTH_INVALID_CREDENTIALS`       | AUTH permanente       | no               | correggere username o password        |
| `AUTH_PASSWORD_POLICY`           | VALIDATION permanente | no               | usare da 8 a 128 caratteri            |
| `AUTH_RATE_LIMITED`              | AUTH temporaneo       | no               | attendere la finestra indicata        |
| `AUTH_SETUP_DISABLED`            | CONFLICT permanente   | no               | usare uno degli account esistenti     |
| `AUTH_INVALID_SETUP_TOKEN`       | AUTH permanente       | no               | verificare il secret locale           |
| `CONFLICT_REVISION`              | CONFLICT              | no               | rileggere e ripetere la modifica      |
| `ORDER_CURRENCY_NOT_SUPPORTED`   | VALIDATION permanente | no               | importare soltanto ordini in euro     |
| `ORDER_INVALID_INPUT`            | VALIDATION permanente | no               | correggere i dati normalizzati        |
| `ORDER_NOT_PREPARABLE`           | CONFLICT permanente   | no               | verificare lo stato dell’ordine       |
| `CREDIT_NOTE_NOT_ALLOWED`        | CONFLICT permanente   | no               | verificare emissione ed esito SdI     |
| `CREDIT_NOTE_LIMIT_EXCEEDED`     | CONFLICT permanente   | no               | verificare il residuo accreditabile   |
| `REFUND_NEEDS_REVIEW`            | VALIDATION permanente | no               | verificare l’importo restituito       |
| `BILLING_CASE_EMPTY`             | CONFLICT permanente   | no               | lasciare la preparazione in archivio  |
| `BILLING_CASE_NOT_EDITABLE`      | CONFLICT permanente   | no               | rileggere lo stato della preparazione |
| `INVALID_CONTENT_TYPE`           | VALIDATION permanente | no               | inviare il formato previsto           |
| `REQUEST_BODY_TOO_LARGE`         | VALIDATION permanente | no               | ridurre il payload                    |
| `REQUEST_ORIGIN_INVALID`         | AUTH permanente       | no               | usare l’origine configurata dell’app  |
| `REQUEST_TIMEOUT`                | NETWORK transitorio   | no per mutazioni | ripetere soltanto dopo readback       |
| `AUTH_PROVIDER_EXPIRED`          | AUTH permanente       | no               | ricollegare il canale                 |
| `AUTH_PROVIDER_ACCOUNT_MISMATCH` | AUTH permanente       | no               | autorizzare l'account configurato     |
| `PROVIDER_RATE_LIMITED`          | PROVIDER transitorio  | sì, con backoff  | attendere o usare il retry manuale    |
| `PROVIDER_UNAVAILABLE`           | PROVIDER transitorio  | sì, con backoff  | verificare il canale e riprovare      |
| `PROVIDER_RESPONSE_TOO_LARGE`    | PROVIDER permanente   | no               | verificare query e contratto          |
| `PROVIDER_RESPONSE_INVALID`      | PROVIDER permanente   | no               | verificare schema e payload           |
| `PROVIDER_NOT_CONFIGURED`        | CONFIG permanente     | no               | configurare e collegare il canale     |
| `WEBHOOK_SIGNATURE_INVALID`      | AUTH permanente       | no               | verificare firma e secret             |
| `EMAIL_CONFIGURATION_MISSING`    | CONFIG permanente     | no               | configurare il trasporto canonico     |
| `EMAIL_DELIVERY_FORBIDDEN`       | AUTH permanente       | no               | usare l’account autorizzato           |
| `EMAIL_RECIPIENT_MISSING`        | VALIDATION permanente | no               | correggere il recapito cliente        |
| `EMAIL_ATTACHMENT_MISSING`       | CONFLICT temporaneo   | no               | importare il PDF ufficiale            |
| `EMAIL_DELIVERY_FAILED`          | NETWORK transitorio   | sì, con backoff  | attendere il retry o reinviare        |
| `EMAIL_DELIVERY_UNCERTAIN`       | UNKNOWN               | no               | verificare prima del reinvio          |
| `ARUBA_BATCH_INVALID`            | CONFLICT permanente   | no               | ricreare il batch dai documenti       |
| `ARUBA_HELPER_TOKEN_INVALID`     | AUTH temporaneo       | no               | generare un nuovo codice di avvio     |
| `ARUBA_HOST_NOT_ALLOWED`         | AUTH permanente       | no               | chiudere e verificare l’indirizzo     |
| `ARUBA_AUTHENTICATION_REQUIRED`  | AUTH presidiato       | no               | completare manualmente nel browser    |
| `ARUBA_DOM_UNRECOGNIZED`         | PROVIDER permanente   | no               | usare il percorso manuale             |
| `ARUBA_VALIDATION_FAILED`        | VALIDATION permanente | no               | rimuovere gli upload e correggere     |
| `ARUBA_OPERATION_FORBIDDEN`      | AUTH permanente       | no               | usare l’account titolare              |
| `ARUBA_SEND_NOT_AUTHORIZED`      | CONFLICT permanente   | no               | verificare kill switch e manifest     |
| `ARUBA_RECONCILIATION_REQUIRED`  | UNKNOWN               | no               | completare il readback                |
| `ARUBA_IMPORT_INVALID`           | VALIDATION permanente | no               | scegliere il file ufficiale corretto  |
| `ARUBA_API_BUDGET_EXHAUSTED`     | PROVIDER permanente   | no               | autorizzare un nuovo manifesto        |
| `UNKNOWN`                        | UNKNOWN               | no               | diagnosticare con request ID          |
