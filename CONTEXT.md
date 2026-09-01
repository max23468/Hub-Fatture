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

**Cliente extra-UE supportato**:
Cliente con Paese di fatturazione svizzero, distinto sia dal cliente UE sia dal destinatario con
Paese non riconosciuto.
_Evita_: Cliente UE, Paese non supportato

**Collegamento del canale di vendita**:
Relazione autenticata con Shopify o eBay. Un errore nell'importazione di un ordine riguarda la
sincronizzazione e non rende falso il collegamento.
_Evita_: Sincronizzazione, Ultimo aggiornamento

**Deroga anagrafica automatica**:
Accettazione tracciata dell’intestazione dichiarata da un privato italiano eBay quando il Codice
Fiscale è formalmente valido e tutti i dati obbligatori per fatturare sono presenti.
_Evita_: Correzione del Codice Fiscale, Verifica anagrafica ufficiale

**Preparazione approvabile**:
Preparazione aperta il cui pagamento è acquisito e che supera, nello stesso istante, tutti i
controlli necessari all’approvazione.
_Evita_: Preparazione pronta, READY

**Preparazione con pagamento in attesa**:
Preparazione aperta che contiene almeno un pagamento non ancora acquisito; questa condizione ha
precedenza nella classificazione operativa anche quando esistono altri controlli.
_Evita_: Ordine in attesa, Preparazione da verificare

**Preparazione da risolvere**:
Preparazione aperta senza pagamenti pendenti che non è approvabile e presenta almeno una causa
bloccante visibile nella preparazione o nella coda Controlli.
_Evita_: Preparazione pronta, Errore generico
