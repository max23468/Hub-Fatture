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
- Chiedi prima di azioni distruttive, deploy o release non già autorizzati da
  una richiesta di pubblicazione, invii Aruba reali, decisioni fiscali o
  modifiche materiali allo scope.
- Non aggiungere dipendenze, servizi o tool non approvati dal Master Plan.
- Fuori dalla roadmap del Master Plan, descrivi capacità e gate osservabili senza duplicare date, branch, conteggi di test o sigle di milestone; lo stato corrente deriva dall’HEAD e dalla CI.
- La sigla `HF` è interna: non deve comparire nel frontend o in contenuti destinati all’utente.
- La repository è pubblica ma proprietaria: non aggiungere `LICENSE`, dati reali, segreti o configurazioni sensibili.
- Non aprire issue, discussion o project rivolti alla community.

## Significato di `Pubblica`

Quando il proprietario, riferendosi alla repository o alla modifica corrente,
dice `Pubblica` o chiede in modo affermativo e inequivocabile di pubblicare,
autorizza l'intero ciclo tecnico applicabile. Domande, ipotesi, pianificazioni e
negazioni non costituiscono autorizzazione. L'agente non si ferma a stati
intermedi e completa tutti i passaggi applicabili: preparazione e verifiche,
branch e commit, versione e changelog quando richiesti, push, PR, soli gate
bloccanti, merge, tag e GitHub Release quando previsti, deploy o promozione
tecnica e verifica live. La sequenza concreta, in particolare tra versionamento,
merge, deploy e release, è quella definita dalla policy della repository.
Per una modifica runtime, appena il merge restituisce lo SHA esatto di `main`,
l'agente avvia `scripts/dispatch-production.sh <sha>` senza attendere localmente
i check post-merge: il workflow Production conserva il proprio gate exact-SHA e
attende autonomamente gli stessi check. Questo anticipo vale soltanto dentro un
ciclo `Pubblica` già autorizzato e non trasforma ogni merge in un auto-deploy.

Prima di aprire una PR di pubblicazione, completa i gate locali applicabili e
presenta un HEAD coerente e pronto alla review. Classifica l'impatto sul
diff cumulativo fra l'ultimo commit distribuito e il candidato finale, non sulla
sola ultima PR. Modifiche esclusivamente documentali, di test o di governance
non richiedono immagine, deploy o release; più modifiche runtime correlate già
assorbite in `main` vengono distribuite insieme una sola volta sul candidato
finale.

Quando una modifica runtime deve essere pubblicata, il bump di versione e la
voce di changelog appartengono alla stessa PR dell'implementazione e devono
essere completati prima del merge. Non fondere la modifica runtime per aprire
poi una seconda PR dedicata soltanto a versione, changelog o release. Se questi
elementi non sono pronti, la PR di implementazione non è pronta al merge. Una
deroga richiede una richiesta esplicita del proprietario riferita al caso
specifico.

La pulizia finale rimuove soltanto branch e worktree temporanei creati nel ciclo
corrente e già assorbiti; controlla stash e altri residui senza alterare elementi
preesistenti o estranei alla pubblicazione. Se un passaggio non è applicabile, lo
dichiara e prosegue con gli altri. La richiesta affermativa di pubblicazione
vale come autorizzazione a PR, merge, deploy tecnico e release previsti dal
ciclo, senza una seconda conferma. Non autorizza pubblicazione di temi Shopify
live, submission Shopify App Store, billing o nuove attivazioni produttive,
TestFlight o App Store, invii Aruba, email o scansioni reali, né aggiornamenti
Notion: queste azioni richiedono una richiesta esplicita separata. Una richiesta
riferita soltanto a una di queste azioni non avvia la pubblicazione della
repository. Non dichiarare `pubblicato` finché il ciclo applicabile e la
rilettura finale di PR, check, deploy, release e stato Git non sono completi.
