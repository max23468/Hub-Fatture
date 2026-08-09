# Istruzioni per gli agenti

`docs/Hub_Fatture_MASTER_PLAN.md` è la fonte canonica per prodotto, UX, brand, architettura, modello commerciale, test, distribuzione e roadmap. Prima di agire leggi la sezione 0 (come leggere la specifica) e le sezioni che il tuo intervento tocca:

| Intervento                                   | Sezioni      |
| -------------------------------------------- | ------------ |
| Dominio ordini, raggruppamento, anagrafica   | 5, 7, 15, 25 |
| Interfaccia, terminologia, brand             | 5, 13        |
| Connettori Shopify ed eBay                   | 8, 9         |
| Aruba, SdI, e-mail al cliente                | 10, 11, 12   |
| Architettura, schema dati, job               | 14, 15, 16   |
| Sicurezza, privacy, requisiti non funzionali | 17, 21       |
| Repository, CI/CD, deployment, backup        | 18, 19, 20   |
| Test e criteri di uscita                     | 22, 31       |
| Roadmap, milestone, decisioni rinviate       | 23, 24, 30   |

In dubbio sulla sezione competente, leggi l'indice del documento invece di leggerlo tutto. Il perimetro confermato (3) e le decisioni consolidate (4) valgono sempre: verificali quando una richiesta sembra uscirne.

- Rispondi sempre in italiano, con accenti e apostrofi corretti.
- Non sovrascrivere modifiche non tue.
- Non mantenere retrocompatibilità o implementazioni legacy: non esistono consumatori esterni da preservare.
- Se lo stesso problema ricorre due volte, correggine la causa condivisa e aggiungi il più piccolo controllo di regressione.
- Decidi autonomamente naming, formattazione e default di routine entro i confini del Master Plan.
- Chiedi prima di azioni distruttive, deploy, release, invii Aruba reali, decisioni fiscali o modifiche materiali allo scope.
- Non aggiungere dipendenze, servizi o tool non approvati dal Master Plan.
- Fuori dalla roadmap del Master Plan, descrivi capacità e gate osservabili senza duplicare date, branch, conteggi di test o sigle di milestone; lo stato corrente deriva dall’HEAD e dalla CI.
- La sigla `HF` è interna: non deve comparire nel frontend o in contenuti destinati all’utente.
- La repository è pubblica ma proprietaria: non aggiungere `LICENSE`, dati reali, segreti o configurazioni sensibili.
- Non aprire issue, discussion o project rivolti alla community.
