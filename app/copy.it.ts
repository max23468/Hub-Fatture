export const copy = {
  appName: "Hub Fatture",
  dashboardTitle: "Dashboard",
  ordersTitle: "Ordini",
  loginTitle: "Accedi",
  setupTitle: "Configura gli accessi",
  logout: "Esci",
  safeEmptyState: "L’ambiente è pronto. Nessun dato è ancora disponibile.",
  errorNotFound: "La pagina non esiste",
  errorUnexpected: "La richiesta non è andata a buon fine",
  errorAction: "Ricarica la pagina oppure torna alla dashboard.",
  errorHome: "Torna alla dashboard",
} as const;

export const orderStatusLabels: Record<string, string> = {
  WAITING_FOR_TRIGGER: "In attesa del trigger",
  ELIGIBLE: "Idoneo",
  GROUPED: "In preparazione",
  CANCELLED_NO_DOCUMENT: "Annullato senza documento",
  REFUNDED_BEFORE_ISSUE: "Rimborsato prima dell’emissione",
  INVOICED: "Fatturato",
  NEEDS_REVIEW: "Da verificare",
};

export const paymentStatusLabels: Record<string, string> = {
  PAID: "Pagato",
  PENDING: "In attesa",
  REFUNDED: "Rimborsato",
};

export const fulfillmentStatusLabels: Record<string, string> = {
  FULFILLED: "Evaso",
  PARTIAL: "Parzialmente evaso",
  UNFULFILLED: "Non evaso",
};

export const customerKindLabels: Record<string, string> = {
  PRIVATE_IT: "Privato italiano",
  BUSINESS_IT: "Azienda italiana",
  EU: "Cliente UE",
  UNKNOWN: "Tipo da verificare",
};

export const customerMatchLabels: Record<string, string> = {
  TAX_ID: "Identificativo fiscale",
  EXACT_PROFILE: "Profilo completo",
  AMBIGUOUS: "Non univoca",
};

export const taxIdentifierLabels: Record<string, string> = {
  CODICE_FISCALE: "Codice Fiscale",
  PARTITA_IVA: "Partita IVA",
  ALTRO: "Altro identificativo",
};

export const auditActionLabels: Record<string, string> = {
  BILLING_CASE_CREATED: "Preparazione fattura creata",
  ORDER_GROUPED: "Ordine aggiunto alla preparazione",
  ORDER_GROUPING_FORCED: "Preparazione anticipata richiesta",
  ORDER_SOURCE_CONFLICT: "Modifica dei dati sorgente da verificare",
  BILLING_CASE_DO_NOT_TRANSMIT: "Preparazione chiusa senza trasmissione",
};

export const billingCaseStatusLabels: Record<string, string> = {
  NEEDS_REVIEW: "Da verificare",
  READY: "Pronta",
  DO_NOT_TRANSMIT: "Da non trasmettere",
};
