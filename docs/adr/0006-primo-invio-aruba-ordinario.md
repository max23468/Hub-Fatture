---
status: accepted
---

# Primo invio Aruba nel flusso ordinario

La qualifica tecnica si chiude senza upload o invii reali. Il primo invio API reale avviene al
go-live soltanto dopo l’autorizzazione separata all’uso Production ordinario e riguarda un documento
già dovuto e approvato nel normale flusso operativo: non viene creato né selezionato un documento
dedicato al collaudo.

## Conseguenze

Il permesso monouso specifico di un canary fiscale e la relativa infrastruttura non fanno parte del
prodotto. Fino al go-live `ARUBA_SUBMISSION_ENABLED=false` resta il confine fail-closed; dopo
l’abilitazione, ogni documento conserva approvazione esplicita, snapshot e hash immutabili,
dry-run sul medesimo XML, controllo dei duplicati e blocco dei retry quando lo stato remoto è
incerto.
