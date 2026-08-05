# Segreti operativi

Questa directory ammette soltanto blob cifrati `.age` esplicitamente previsti dal Master Plan.

La chiave SSH VPS in chiaro, le identità private `age` e le passphrase restano fuori dal repository. Prima di versionare un blob cifrato, verificarne localmente la decifrabilità e l'equivalenza con l'originale senza stampare materiale sensibile.

Destinatario pubblico `age`:

`age1zkwv2z4xfpdrrpvzlefudjlrfmxyxj6xcaz84p7p4g7nsdz26fys3zwupn`

## Uso e recovery

La copia cifrata può essere decifrata soltanto con `age-identity.txt`, conservata nel recovery kit locale protetto sul Mac. Usarla in streaming e non creare copie plaintext persistenti; verificare sempre che la chiave pubblica SSH ottenuta coincida con quella attesa.

## Rotazione

Generare una nuova identità fuori dal repository, cifrare nuovamente il blob verso il nuovo destinatario pubblico e verificarne il round-trip prima di aggiornare questo file. Conservare la vecchia identità finché il nuovo blob non è stato verificato; revoca o eliminazione richiedono una decisione esplicita del titolare.
