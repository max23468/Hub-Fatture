# Brand Foundation

Stato: **approvata dal titolare**.

## Identità

- Nome: **Hub Fatture**.
- La sigla tecnica **HF** è riservata agli identificatori dei requisiti e alla discussione interna: non compare mai nell’interfaccia, nei nomi accessibili, nelle notifiche o nei documenti destinati all’utente.
- Marchio canonico: [`assets/hub-fatture-mark.svg`](assets/hub-fatture-mark.svg).
- Variante per fondi scuri: [`assets/hub-fatture-mark-on-dark.svg`](assets/hub-fatture-mark-on-dark.svg).
- Favicon: [`assets/favicon.svg`](assets/favicon.svg).

Il marchio rappresenta due flussi in ingresso, il nodo Hub Fatture e un flusso in uscita. La relazione Shopify/eBay → Hub Fatture → Aruba è intenzionale ma non didascalica: il segno non usa lettere, frecce né marchi dei provider.

## Direzione visiva

Riferimenti di principio: Xero per gerarchia e chiarezza contabile, Odoo per densità operativa e tabelle, Revolut Business per velocità percepita e finitura. La sintesi approvata è moderna, rapida, autorevole e sobria, con densità intermedia orientata allo spazio.

### Colori semantici

I componenti usano ruoli semantici, mai valori cromatici diretti. Light e dark mode non sono inversioni automatiche.

| Ruolo                |     Light |      Dark |
| -------------------- | --------: | --------: |
| Sfondo               | `#F4F8FA` | `#071722` |
| Superficie           | `#FFFFFF` | `#0B1F2B` |
| Superficie attenuata | `#EAF2F5` | `#102936` |
| Testo                | `#0B2533` | `#E9F6F8` |
| Testo secondario     | `#536B77` | `#9DB2BD` |
| Bordo                | `#CBD9DF` | `#28414E` |
| Brand                | `#064B63` | `#45CBE0` |
| Azione primaria      | `#05627D` | `#087B99` |
| Accento              | `#08A7C2` | `#45CBE0` |
| Successo             | `#167A5A` | `#55C69C` |
| Avviso               | `#A35F00` | `#F4B64C` |
| Errore               | `#B4232D` | `#FF737B` |

Il colore non è mai l’unico indicatore di stato: servono sempre etichetta testuale e, quando utile, icona.

## Tipografia, spazio e forma

- Stack di sistema: `ui-sans-serif`, `system-ui`, `-apple-system`, `BlinkMacSystemFont`, `Segoe UI`, `sans-serif`; nessun webfont.
- Testo operativo di base: `14–16px`; gerarchia compatta e leggibile anche a zoom 200%.
- Scala di spazio basata su `4, 8, 12, 16, 24, 32, 48px`.
- Raggio base `8px`; raggi maggiori soltanto per contenitori ampi e sovrapposizioni.
- Separazione tramite spazio, allineamento e divisori; ombre soltanto per menu, popover e dialoghi.
- Iconografia lineare coerente fornita esclusivamente da Lucide React.
- Movimento breve e funzionale; nessuna animazione decorativa e rispetto di `prefers-reduced-motion`.

## Temi

Sono disponibili tre preferenze: **Sistema**, **Chiaro**, **Scuro**. Al primo accesso vale il sistema operativo; una scelta manuale viene conservata localmente. Tutti i componenti condividono gli stessi token semantici in entrambi i temi.

## Layout e navigazione

Desktop-first, con tutte le operazioni disponibili anche da smartphone.

La navigazione desktop usa una sidebar fissa, non comprimibile e a un solo livello. Le destinazioni canoniche sono:

1. Dashboard
2. Ordini
3. Documenti
4. Clienti
5. Attività
6. Impostazioni

`Ordini` comprende le viste Tutti, Da fatturare, Da verificare, In attesa e Annullati; il raggruppamento interno degli ordini si apre come `Preparazione fattura`, non come destinazione autonoma. `Documenti` distingue nella pagina Fatture, Note di credito e stati di trasmissione. `Attività` contiene Da gestire e Cronologia. `Impostazioni` contiene anche Connessioni. Una destinazione compare nella navigazione solo quando offre una superficie utilizzabile. Ricerca e profilo sono allineati in alto a destra nel page header, senza una barra superiore permanente.

Su mobile la navigazione principale è inferiore e usa `Altro` per le destinazioni restanti. Le tabelle diventano righe verticali espandibili: stato, cliente, importo e azione primaria restano immediatamente disponibili, senza scorrimento orizzontale.

## Componenti e pattern interni

La fondazione UI comprende soltanto primitive effettivamente usate: pulsanti, campi, selezioni, navigazione, tabelle responsive, etichette di stato, messaggi inline, notifiche, menu, popover, dialoghi, skeleton e scheletro pagina. Ogni componente documenta varianti, stati, tastiera e nome accessibile vicino al codice che lo usa.

Non esistono un pacchetto di componenti separato, Storybook, una brand board o una libreria pubblica: il sistema interno è costituito da token CSS, componenti React accessibili e pattern applicativi condivisi.

Le azioni fiscali irreversibili usano una pagina di conferma dedicata con conseguenza e riepilogo completo. I dialoghi sono riservati a operazioni brevi e reversibili. Le azioni primarie restano visibili; quelle secondarie possono usare un menu, senza dipendere dal solo hover.

## Tono e uso

Il testo è diretto e impersonale. Mostra prima il fatto osservato, poi la conseguenza e infine l’azione disponibile. Non usa saluti decorativi né dichiara conformità, trasmissione o successo senza readback autorevole.

Il marchio identifica l’app e non è un indicatore di stato. Non va deformato, ricolorato per errori o successi, oppure combinato con i marchi Shopify, eBay o Aruba. La variante chiara si usa soltanto su fondi scuri; la favicon usa il contenitore dedicato.
