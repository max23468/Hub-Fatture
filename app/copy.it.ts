import type { AuditAction } from "../src/db/audit.server.ts";

export const copy = {
  appName: "Hub Fatture",
  navigation: {
    dashboard: "Dashboard",
    orders: "Ordini",
    activity: "Attività",
    settings: "Impostazioni",
    mainLabel: "Navigazione principale",
    skipToContent: "Vai al contenuto principale",
    openProfile: (username: string) => `Apri il menu di ${username}`,
    logout: "Esci",
  },
  common: {
    unavailable: "Non disponibile",
    unavailablePlural: "Non disponibili",
    unknownStatus: "Stato non riconosciuto",
    unknownType: "Tipo non riconosciuto",
  },
  login: {
    eyebrow: "Area riservata",
    title: "Accedi",
    username: "Nome utente",
    password: "Password",
    submit: "Accedi",
  },
  setup: {
    eyebrow: "Prima configurazione",
    title: "Configura gli accessi",
    code: "Codice di configurazione",
    passwordFor: (username: string) => `Password per ${username} (minimo 8 caratteri)`,
    submit: "Crea gli account",
  },
  dashboard: {
    eyebrow: "Situazione operativa",
    title: "Dashboard",
    summaryLabel: "Riepilogo ordini e fatturazione",
    importedOrders: "Ordini importati",
    readyPreparations: "Preparazioni pronte",
    reviews: "Da verificare",
    waitingOrders: "Ordini non ancora pronti",
    pendingPayments: "Pagamenti in attesa",
  },
  orders: {
    eyebrow: "Vendite online",
    title: "Ordini",
    intro: "Controlla gli ordini di Shopify ed eBay e prepara le relative fatture.",
    viewsLabel: "Viste ordini",
    views: {
      all: "Tutti",
      toInvoice: "Da fatturare",
      toReview: "Da verificare",
      waiting: "In attesa",
      cancelled: "Annullati",
    },
    filterLabel: "Filtra gli ordini",
    search: "Cerca",
    searchPlaceholder: "Numero ordine o cliente",
    salesChannel: "Canale di vendita",
    orderDate: "Data ordine (facoltativa)",
    payment: "Pagamento",
    invoicingStatus: "Fatturazione",
    filter: "Filtra",
    allFeminine: "Tutte",
    allMasculine: "Tutti",
    loadExamples: "Carica ordini di esempio",
    examplesLoaded: (imported: string, updated: string | null, ignored: string | null) =>
      `Ordini di esempio caricati. Nuovi: ${imported}; aggiornati: ${updated ?? "0"}; meno recenti ignorati: ${ignored ?? "0"}.`,
    preparation: "Preparazione fattura",
    customer: "Cliente",
    date: "Data",
    orders: "Ordini",
    total: "Totale",
    status: "Stato",
    order: "Ordine",
    noTransmittedPreparations: "Preparazioni non trasmesse",
    noReviews: "Nessuna verifica richiesta",
    nothingToInvoice: "Niente da fatturare",
    preparationEmptyHelp:
      "Le preparazioni compaiono qui quando gli ordini sono pronti per la fatturazione.",
    cancelledOrders: "Ordini annullati o rimborsati",
    noCancelledOrders: "Nessun ordine annullato",
    noOrders: "Nessun ordine",
    noOrdersHelpDevelopment: "Carica gli ordini di esempio oppure modifica i filtri.",
    noOrdersHelpProduction: "Modifica i filtri oppure attendi la prossima importazione.",
    openPreparation: (number: string) => `Apri preparazione fattura ${number}`,
  },
  orderDetail: {
    order: (number: string) => `Ordine ${number}`,
    orderStatus: "Stato dell’ordine",
    payment: "Pagamento",
    shipping: "Spedizione",
    invoicing: "Fatturazione",
    preparation: "Preparazione fattura",
    notStarted: "Non avviata",
    prepareNow: "Prepara la fattura ora",
    customerData: "Dati del cliente",
    hubCustomerData: "Usati da Hub Fatture",
    customerType: "Tipo cliente",
    email: "E-mail",
    address: "Indirizzo",
    recognizedBy: "Cliente riconosciuto tramite",
    manualCheck: "Controllo manuale",
    required: "Necessario",
    notRequired: "Non necessario",
    taxData: "Dati fiscali",
    receivedCustomerData: (provider: string) => `Ricevuti da ${provider}`,
    name: "Nome",
    receivedTaxData: "Dati fiscali ricevuti",
    possibleMatchTitle: "Possibile cliente già presente",
    possibleMatchHelp:
      "I dati non sono abbastanza certi per unire gli ordini. Se si tratta dello stesso cliente, correggi l’anagrafica della preparazione.",
    taxIdentifier: "Dato fiscale",
    payments: "Pagamenti",
    noPayments: "Nessun pagamento registrato.",
    manuallyRecorded: "registrato manualmente",
    purchasedItems: "Articoli acquistati",
    description: "Descrizione",
    quantity: "Quantità",
    amount: "Importo",
    discount: "Sconto",
  },
  preparation: {
    eyebrow: "Da fatturare",
    title: (number: string) => `Preparazione fattura ${number}`,
    includedOrders: "Ordini inclusi",
    summary: "Riepilogo",
    currentStatus: "Situazione",
    currency: "Valuta",
    orders: "Ordini",
    reason: "Motivo della scelta",
    reasonHelp: "Spiega perché questa preparazione non deve diventare una fattura.",
    doNotTransmit: "Non trasmettere",
    reactivate: "Riattiva preparazione",
    reviewWarning: "Prima di proseguire, controlla i dati indicati come incompleti o modificati.",
    notTransmittedDefault: "Questa preparazione non deve essere trasmessa.",
    changesTitle: "Aggiornamenti ricevuti",
    changesIntro: "I dati precedenti restano disponibili nel registro per il controllo.",
    changedOrderData: "I dati ricevuti per questo ordine sono cambiati.",
    checksTitle: "Cose da controllare",
    checkFallback: "Controlla i dati della preparazione prima di proseguire.",
    customerRecord: "Dati cliente",
    customerRecordOriginal: "Ricevuti dal canale di vendita",
    activity: "Registro attività",
    noActivity: "Nessuna attività registrata.",
    archivedOnly: "Questa preparazione resta consultabile in archivio e non può essere riattivata.",
  },
  activity: {
    eyebrow: "Controlli e cronologia",
    title: "Attività",
    intro: "Vedi subito cosa richiede attenzione e consulta le operazioni già registrate.",
    viewsLabel: "Viste attività",
    toManage: "Da gestire",
    history: "Cronologia",
    nothingToManage: "Niente da gestire",
    nothingToManageHelp: "Nessuna preparazione o ordine richiede una verifica.",
    searchLabel: "Cerca nel registro",
    search: "Cerca",
    searchPlaceholder: "Numero ordine, preparazione o motivo",
    type: "Tipo di attività",
    all: "Tutte",
    filter: "Filtra",
    activity: "Attività",
    subject: "Elemento",
    author: "Autore",
    when: "Quando",
    system: "Sistema",
    recorded: "Attività registrata",
    noHistory: "Nessuna attività registrata",
    noHistoryHelp: "Modifica i filtri oppure attendi la prossima operazione.",
    preparation: (number: string) => `Preparazione fattura ${number}`,
    order: (provider: string, number: string) => `${provider} ${number}`,
    settings: "Impostazioni",
  },
  settings: {
    eyebrow: "Preferenze di fatturazione",
    title: "Impostazioni",
    intro: "Queste preferenze valgono per Shopify ed eBay.",
    saved: "Impostazione aggiornata. Gli ordini in attesa sono stati ricontrollati.",
    preparationTitle: "Quando preparare la fattura",
    preparationHelp:
      "La modifica vale per gli ordini non ancora inseriti in una preparazione. Quelli già pronti non cambiano.",
    preparationLabel: "Prepara la fattura",
    onPaid: "Quando il pagamento è confermato",
    onFulfilled: "Quando l’ordine è completamente spedito",
    save: "Salva impostazione",
    timeTitle: "Data e ora",
    timeHelp: "Le date degli ordini seguono l’ora italiana.",
  },
  customerEditor: {
    title: "Dati del destinatario",
    intro:
      "Le modifiche valgono per questa preparazione. I dati ricevuti dal canale di vendita restano consultabili nel dettaglio dell’ordine.",
    identity: "Cliente",
    address: "Indirizzo di fatturazione",
    tax: "Dati fiscali",
    kind: "Tipo destinatario",
    displayName: "Nome da mostrare",
    firstName: "Nome",
    lastName: "Cognome",
    companyName: "Ragione sociale",
    phone: "Telefono",
    email: "E-mail",
    line1: "Indirizzo",
    line2: "Indirizzo, seconda riga",
    postalCode: "CAP",
    city: "Città",
    province: "Provincia",
    country: "Paese",
    countryHelp: "Usa due lettere, per esempio IT per Italia.",
    identifier: (number: number) => `Dato fiscale ${number}`,
    newIdentifier: "Nuovo dato fiscale",
    type: "Tipo",
    value: "Valore",
    emptyRemoves: "Lascia vuoto per rimuoverlo.",
    reason: "Motivo della correzione",
    save: "Salva dati cliente",
  },
  theme: {
    label: "Tema",
    system: "Sistema",
    light: "Chiaro",
    dark: "Scuro",
  },
  error: {
    eyebrow: "Errore",
    notFound: "La pagina non esiste",
    unexpected: "La richiesta non è andata a buon fine",
    action: "Ricarica la pagina oppure torna alla dashboard.",
    home: "Torna alla dashboard",
  },
} as const;

export const orderStatusLabels: Record<string, string> = {
  WAITING_FOR_TRIGGER: "In attesa di pagamento o spedizione",
  ELIGIBLE: "Da preparare",
  GROUPED: "Fattura in preparazione",
  CANCELLED_NO_DOCUMENT: "Annullato, nessuna fattura",
  REFUNDED_BEFORE_ISSUE: "Rimborsato, nessuna fattura",
  INVOICED: "Fatturato",
  NEEDS_REVIEW: "Da verificare",
};

export const paymentStatusLabels: Record<string, string> = {
  PAID: "Pagato",
  PENDING: "In attesa",
  REFUNDED: "Rimborsato",
};

export const fulfillmentStatusLabels: Record<string, string> = {
  FULFILLED: "Spedito",
  PARTIAL: "Spedito in parte",
  UNFULFILLED: "Non ancora spedito",
};

export const customerKindLabels: Record<string, string> = {
  PRIVATE_IT: "Privato italiano",
  BUSINESS_IT: "Azienda italiana",
  EU: "Cliente UE",
  UNKNOWN: "Tipo da verificare",
};

export const customerMatchLabels: Record<string, string> = {
  TAX_ID: "codice fiscale o partita IVA",
  EXACT_PROFILE: "nome, indirizzo ed e-mail",
  AMBIGUOUS: "dati da verificare",
};

export const taxIdentifierLabels: Record<string, string> = {
  CODICE_FISCALE: "Codice fiscale",
  PARTITA_IVA: "Partita IVA",
  ALTRO: "Altro dato fiscale",
};

export const auditActionLabels = {
  ADMIN_ACCOUNT_CREATED: "Account amministrativo creato",
  BILLING_CASE_CREATED: "Preparazione fattura creata",
  BILLING_CASE_DO_NOT_TRANSMIT: "Preparazione chiusa senza trasmissione",
  BILLING_CASE_REACTIVATED: "Preparazione riattivata",
  CUSTOMER_CORRECTED: "Anagrafica cliente corretta",
  DRAFT_TRIGGER_CHANGED: "Regola di preparazione modificata",
  LOGIN_FAILED: "Accesso rifiutato",
  LOGIN_RATE_LIMITED: "Accessi temporaneamente bloccati",
  LOGIN_SUCCEEDED: "Accesso riuscito",
  LOGOUT_SUCCEEDED: "Uscita registrata",
  ORDER_GROUPED: "Ordine aggiunto alla preparazione",
  ORDER_GROUPING_FORCED: "Preparazione anticipata richiesta",
  ORDER_IMPORTED: "Ordine importato",
  ORDER_SEPARATED: "Ordine separato dalla preparazione",
  ORDER_SOURCE_CONFLICT: "Aggiornamento dell’ordine da verificare",
  ORDER_SOURCE_UPDATED: "Ordine aggiornato dal canale di vendita",
} satisfies Record<AuditAction, string>;

export function auditActionLabel(action: string) {
  return (auditActionLabels as Record<string, string>)[action];
}

export const billingCaseStatusLabels: Record<string, string> = {
  DRAFT: "In lavorazione",
  NEEDS_REVIEW: "Da verificare",
  READY: "Pronta",
  DO_NOT_TRANSMIT: "Da non trasmettere",
  APPROVED: "Approvata",
  CLOSED: "Chiusa",
};

/** Ogni anomalia dichiara il fatto osservato e l'azione che la chiude (13.9). */
export const anomalyLabels: Record<string, { title: string; action: string }> = {
  PENDING_PAYMENT: {
    title: "Pagamento non ancora acquisito",
    action: "Attendi l\u2019incasso oppure registra il pagamento sul canale di vendita.",
  },
  TOTALS_MISMATCH: {
    title: "Totale dell\u2019ordine non riconciliato",
    action:
      "Articoli, spedizione e pagamenti non ricostruiscono il totale ricevuto: verifica l’ordine sul canale di vendita.",
  },
  CUSTOMER_INCOMPLETE: {
    title: "Anagrafica fiscale incompleta",
    action: "Completa i dati del cliente in questa pagina.",
  },
  CUSTOMER_MISMATCH: {
    title: "Anagrafiche discordanti fra gli ordini",
    action: "Correggi l\u2019anagrafica della preparazione oppure separa l\u2019ordine incoerente.",
  },
  SOURCE_CONFLICT: {
    title: "L’ordine è cambiato dopo la preparazione",
    action: "Confronta le versioni conservate qui sotto prima di proseguire.",
  },
  ORDER_NOT_BILLABLE: {
    title: "Ordine annullato o rimborsato",
    action: "Separa l\u2019ordine oppure archivia la preparazione con “Non trasmettere”.",
  },
};

export const reactivationBlockerMessages: Record<string, string> = {
  EMPTY:
    "Questa preparazione storica non contiene più ordini e resta consultabile soltanto in archivio.",
  INCOMPATIBLE_ORDERS:
    "Gli ordini sono ancora annullati o rimborsati. La preparazione resta in archivio finché il canale di vendita non li rettifica.",
  OTHER_OPEN_CASE:
    "Esiste già un’altra preparazione aperta per lo stesso cliente e giorno. Questa resta in archivio.",
};
