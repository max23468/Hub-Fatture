import type { AuditAction } from "../src/db/audit.server.ts";

export const copy = {
  appName: "Hub Fatture",
  dashboardTitle: "Dashboard",
  ordersTitle: "Ordini",
  activityTitle: "Attività",
  settingsTitle: "Impostazioni",
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
  ADMIN_ACCOUNT_CREATED: "Account amministrativo creato",
  BILLING_CASE_CREATED: "Preparazione fattura creata",
  BILLING_CASE_DO_NOT_TRANSMIT: "Preparazione chiusa senza trasmissione",
  BILLING_CASE_REACTIVATED: "Preparazione riattivata",
  CUSTOMER_CORRECTED: "Anagrafica cliente corretta",
  DRAFT_TRIGGER_CHANGED: "Trigger di preparazione modificato",
  LOGIN_FAILED: "Accesso rifiutato",
  LOGIN_RATE_LIMITED: "Accessi temporaneamente bloccati",
  LOGIN_SUCCEEDED: "Accesso riuscito",
  LOGOUT_SUCCEEDED: "Uscita registrata",
  ORDER_GROUPED: "Ordine aggiunto alla preparazione",
  ORDER_GROUPING_FORCED: "Preparazione anticipata richiesta",
  ORDER_IMPORTED: "Ordine importato",
  ORDER_SEPARATED: "Ordine separato dalla preparazione",
  ORDER_SOURCE_CONFLICT: "Modifica dei dati sorgente da verificare",
  ORDER_SOURCE_UPDATED: "Dati sorgente aggiornati",
} satisfies Record<AuditAction, string>;

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
    action: "Attendi l\u2019incasso oppure registra il pagamento sulla piattaforma sorgente.",
  },
  TOTALS_MISMATCH: {
    title: "Totale dell\u2019ordine non riconciliato",
    action:
      "Righe, spedizione e pagamenti non ricostruiscono il totale importato: verifica la sorgente.",
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
    title: "Dati sorgente cambiati dopo il raggruppamento",
    action: "Confronta le versioni conservate qui sotto prima di proseguire.",
  },
  ORDER_NOT_BILLABLE: {
    title: "Ordine annullato o rimborsato",
    action: "Separa l\u2019ordine oppure archivia la preparazione con `Non trasmettere`.",
  },
};
