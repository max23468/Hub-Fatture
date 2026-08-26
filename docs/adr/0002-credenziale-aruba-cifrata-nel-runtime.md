---
status: accepted
---

# Credenziale Aruba cifrata nel runtime Production

Il runtime Production custodirà la credenziale Aruba nel record della connessione, cifrata con
la chiave master già usata per gli altri connettori. Soltanto Massimo può configurarla o ruotarla
da Impostazioni; il server verifica ambiente, identità fiscale e stato dell'account prima di
accettarla, non la restituisce mai al frontend e audita configurazione, rotazione e revoca senza
registrarne il valore.

## Conseguenze

Sincronizzazioni e trasmissioni API possono essere eseguite dal worker senza dipendere dal Mac.
Backup e restore conservano soltanto il ciphertext e richiedono il recovery kit della chiave
master; compromissione, password cambiata, account scaduto o delega revocata sospendono
fail-closed la connessione e ogni mutazione fiscale. Una credenziale API dedicata potrà
sostituire username e password se Aruba la renderà disponibile, senza cambiare questo confine di
custodia.
