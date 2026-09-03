# API del profilo fiscale

L’API interna aggiorna il profilo fiscale applicativo di Hub Fatture. Non modifica il profilo di
fatturazione dell’account Aruba e non esegue upload o invii.

## Autenticazione e autorizzazione

Entrambi gli endpoint richiedono una sessione amministrativa valida. Il `POST` richiede inoltre:

- `can_approve=true`, verificato nuovamente nel servizio server;
- `Origin` coerente con `APP_BASE_URL`;
- il token CSRF della sessione nel campo `csrf`;
- la conferma letterale `DOCUMENTI_SDI_ACCETTATI` nel campo `confirmation`.

La risposta non espone identità, XML, hash o ultimo progressivo osservato. Usa sempre
`Cache-Control: no-store, private` e `Vary: Cookie`.

## Lettura

`GET /api/profilo-fiscale` restituisce `200` con il solo riepilogo non sensibile della versione
attiva:

```json
{
  "profile": {
    "version": 2,
    "status": "AUDITED",
    "auditedAt": "YYYY-MM-DDTHH:mm:ss.sssZ",
    "taxRegime": "RF14",
    "taxNature": "N5",
    "series": "FPR",
    "cadence": "ANNUAL",
    "sharedByInvoiceAndCreditNote": true
  }
}
```

`profile` è `null` quando non esiste una versione attiva.

## Attivazione

`POST /api/profilo-fiscale` accetta esclusivamente `multipart/form-data`:

| Campo               | Obbligatorio | Contenuto                                                              |
| ------------------- | ------------ | ---------------------------------------------------------------------- |
| `csrf`              | sì           | token CSRF associato alla sessione                                     |
| `confirmation`      | sì           | valore esatto `DOCUMENTI_SDI_ACCETTATI`                                |
| `expectedVersion`   | sì           | versione letta dal `GET`, oppure `0` se `profile` era `null`           |
| `profileXml`        | sì           | TD01 FPR12 già accettata dallo SdI                                     |
| `latestDocumentXml` | no           | ultimo TD01 o TD04 accettato della serie, se successivo a `profileXml` |

Ogni XML deve essere UTF-8, non vuoto, entro 4,9 MB e conforme allo schema FatturaPA verificato
offline. Se `latestDocumentXml` manca, il chiamante conferma implicitamente che `profileXml` è anche
l’ultimo documento accettato della serie.

La conformità dell’XML non dimostra da sola l’accettazione SdI: il valore di `confirmation` è
un’attestazione operativa. I file devono quindi provenire dal download ufficiale Aruba/SdI o da un
readback già riconciliato; l’endpoint non interroga né modifica il provider.

Il server estrae il profilo dal documento, prende il progressivo più recente, acquisisce un lock
transazionale e confronta `expectedVersion` con la versione attiva. Una modifica concorrente viene
rifiutata con `CONFLICT_REVISION`; un retry dello stesso contenuto restituisce invece la versione già
attiva senza creare un nuovo audit. Negli altri casi impedisce regressioni della numerazione, ritira
la versione precedente, crea la nuova versione `AUDITED` e registra l’audit critico nella stessa
transazione.

Una nuova attivazione risponde `201` con `created: true`; un retry idempotente risponde `200` con
`created: false`. In entrambi i casi `profile` usa lo stesso formato del `GET` ed è costruito dal
risultato della transazione appena conclusa, senza una seconda lettura potenzialmente concorrente.

Gli errori usano i codici stabili del registro. In particolare: `401` per sessione assente, `403`
per origine, CSRF o autorizzazione non validi, `413` per richiesta oltre limite, `415` per formato
diverso da multipart, `FISCAL_PROFILE_CONFIRMATION_REQUIRED` o `FISCAL_PROFILE_SOURCE_INVALID`
con stato `422` e `CONFLICT_REVISION` con stato `409` se la versione attiva è cambiata.
