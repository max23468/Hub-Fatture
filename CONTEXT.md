# Hub Fatture

Hub Fatture governa il ciclo che collega ordini commerciali, documenti fiscali locali e documenti
osservati presso Aruba senza confondere le diverse autorità o fonti temporali.

## Linguaggio

**Gruppo API Aruba**:
Contenitore restituito dalla ricerca Aruba che può includere zero, uno o più documenti. Non è un
documento fiscale e il suo identificativo non è automaticamente l’identificativo del documento.
_Evita_: Fattura API

**Documento Aruba**:
Documento fiscale individuale osservato tramite API o fallback, identificato nel relativo account e
ambiente da un ID remoto o da un’identità fiscale univoca.
_Evita_: Gruppo Aruba, Riga Aruba

**Snapshot shadow**:
Vista temporanea e non autoritativa di documenti Aruba usata esclusivamente per confrontare due
canali durante la transizione.
_Evita_: Inventario canonico, Sincronizzazione

**Correlazione shadow**:
Associazione univoca fra due documenti appartenenti a snapshot shadow diversi, basata su un ID
remoto condiviso oppure sulla stessa identità fiscale completa.
_Evita_: Match per data, Match per conteggio

**Parità shadow**:
Esito in cui ogni documento dei due snapshot ha una correlazione univoca e le invarianti e lo stato
canonico coincidono.
_Evita_: Conteggi uguali, Date vicine
