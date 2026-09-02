/** Ogni anomalia dichiara il fatto osservato e l’azione che la chiude. */
export const anomalyLabels: Record<string, { title: string; action: string }> = {
  ARUBA_INVENTORY_BLOCKED: {
    title: "Inventario Aruba non disponibile",
    action:
      "Completa la sincronizzazione o la verifica indicata in Controlli prima di approvare la preparazione.",
  },
  PENDING_PAYMENT: {
    title: "Pagamento non ancora acquisito",
    action:
      "Attendi l’incasso oppure registralo nella bozza fiscale senza modificare il canale di vendita.",
  },
  TOTALS_MISMATCH: {
    title: "Totale dell’ordine non riconciliato",
    action:
      "Articoli, spedizione e pagamenti non ricostruiscono il totale ricevuto: verifica l’ordine sul canale di vendita.",
  },
  ALREADY_INVOICED: {
    title: "Ordine già collegato a una fattura",
    action: "Verifica il documento esistente e separa dalla preparazione gli ordini già fatturati.",
  },
  FISCAL_PROFILE_UNAVAILABLE: {
    title: "Profilo fiscale non disponibile",
    action: "Verifica il profilo fiscale attivo nelle Impostazioni prima di creare il documento.",
  },
  DRAFT_REQUIRES_REFRESH: {
    title: "Bozza fiscale da aggiornare",
    action: "Riapri e salva la bozza sulla revisione corrente prima dell’approvazione.",
  },
  PREPARATION_REVIEW_REQUIRED: {
    title: "Preparazione da verificare",
    action:
      "Rileggi i dati della preparazione e completa i controlli indicati prima di approvarla.",
  },
  CUSTOMER_INCOMPLETE: {
    title: "Anagrafica fiscale incompleta",
    action: "Completa i dati del cliente in questa pagina.",
  },
  CUSTOMER_MISMATCH: {
    title: "Anagrafiche discordanti fra gli ordini",
    action: "Correggi l’anagrafica della preparazione oppure separa l’ordine incoerente.",
  },
  SOURCE_CONFLICT: {
    title: "L’ordine è cambiato dopo la preparazione",
    action: "Confronta le versioni conservate qui sotto prima di proseguire.",
  },
  ARUBA_POTENTIAL_MATCH: {
    title: "Possibile fattura già presente su Aruba",
    action:
      "Apri Documenti → Da collegare e verifica il documento. Il collegamento definitivo richiede l’XML ufficiale.",
  },
  ORDER_NOT_BILLABLE: {
    title: "Ordine annullato o rimborsato",
    action: "Separa l’ordine oppure archivia la preparazione con “Non trasmettere”.",
  },
};
