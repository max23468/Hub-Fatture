export const errorCatalog = {
  AUTH_CURRENT_PASSWORD_INVALID: "La password attuale non è corretta.",
  AUTH_INVALID_CREDENTIALS: "Nome utente o password non validi.",
  AUTH_PASSWORD_CONFIRMATION: "La conferma non coincide con la nuova password.",
  AUTH_PASSWORD_POLICY: "La password deve contenere da 8 a 128 caratteri.",
  AUTH_PASSWORD_REUSE: "Scegli una password diversa da quella attuale.",
  AUTH_RATE_LIMITED: "Troppi tentativi. Riprova più tardi.",
  AUTH_SETUP_DISABLED: "Gli account sono già configurati.",
  AUTH_INVALID_SETUP_TOKEN: "Codice di configurazione non valido.",
  CONFLICT_REVISION: "I dati sono cambiati. Ricarica la pagina e riprova.",
  ORDER_CURRENCY_NOT_SUPPORTED: "Sono ammessi soltanto ordini in euro.",
  ORDER_INVALID_INPUT: "I dati dell’ordine non sono validi.",
  ORDER_HISTORY_RECONCILIATION_FORBIDDEN:
    "Solo il titolare può registrare la riconciliazione dello storico.",
  ORDER_HISTORY_INVOICE_REQUIRED:
    "Allega l’XML ufficiale della fattura Aruba prima di registrare questo esito.",
  ORDER_HISTORY_INVOICE_INVALID:
    "L’XML non identifica una fattura Aruba compatibile con il profilo fiscale attivo.",
  ORDER_NOT_PREPARABLE:
    "Un ordine annullato o già rimborsato non può essere preparato per la fatturazione.",
  BILLING_CASE_EMPTY: "Una preparazione senza ordini resta archiviata e non può essere riattivata.",
  BILLING_CASE_NOT_EDITABLE:
    "Questa preparazione non è più modificabile nello stato in cui si trova.",
  DOCUMENT_APPROVAL_FORBIDDEN: "Solo il titolare può approvare e numerare un documento.",
  DOCUMENT_FISCAL_PROFILE_MISSING: "Configura e approva il profilo fiscale prima di proseguire.",
  DOCUMENT_INVALID: "La bozza fiscale contiene dati incompleti o non validi.",
  DOCUMENT_NOT_APPROVABLE: "La preparazione non è pronta per l’approvazione.",
  DOCUMENT_PROJECTION_STALE: "La proiezione fiscale è cambiata. Rileggila prima di approvare.",
  DOCUMENT_STORAGE_FAILED: "Non è stato possibile archiviare il documento fiscale.",
  CREDIT_NOTE_NOT_ALLOWED: "La fattura originaria non consente ancora una nota di credito.",
  CREDIT_NOTE_LIMIT_EXCEEDED: "Il rimborso supera il residuo accreditabile della fattura.",
  REFUND_NEEDS_REVIEW: "L’importo restituito al cliente deve essere verificato.",
  EMAIL_CONFIGURATION_MISSING: "Il trasporto e-mail canonico non è configurato.",
  EMAIL_DELIVERY_DISABLED: "L’invio e-mail da Hub Fatture è disattivato.",
  EMAIL_DELIVERY_FORBIDDEN: "Solo Massimo può autorizzare l’invio di e-mail al cliente.",
  EMAIL_RECIPIENT_MISSING: "Il documento non ha un destinatario e-mail valido.",
  EMAIL_ATTACHMENT_MISSING: "La copia PDF ufficiale non è ancora disponibile.",
  EMAIL_DELIVERY_FAILED: "L’invio e-mail non è riuscito. Correggi il problema prima del reinvio.",
  EMAIL_DELIVERY_TEMPORARY: "Il servizio e-mail è temporaneamente indisponibile.",
  EMAIL_DELIVERY_UNCERTAIN: "L’esito SMTP è incerto: verifica prima di autorizzare un nuovo invio.",
  ARUBA_BATCH_INVALID: "Il batch Aruba non coincide con i documenti approvati.",
  ARUBA_HELPER_TOKEN_INVALID: "Il codice di avvio dell’helper non è valido o è scaduto.",
  ARUBA_HOST_NOT_ALLOWED: "L’helper ha rilevato un indirizzo non autorizzato.",
  ARUBA_AUTHENTICATION_REQUIRED: "Completa l’autenticazione nel browser e riprendi dall’helper.",
  ARUBA_DOM_UNRECOGNIZED: "La pagina Aruba non corrisponde al contratto verificato.",
  ARUBA_VALIDATION_FAILED: "Aruba ha rifiutato almeno un documento del batch.",
  ARUBA_OPERATION_FORBIDDEN: "Solo il titolare può eseguire questa operazione Aruba.",
  ARUBA_SEND_NOT_AUTHORIZED:
    "L’invio automatico non è abilitato o il manifest non coincide con il batch validato.",
  ARUBA_RECONCILIATION_REQUIRED:
    "Lo stato remoto è incerto: completa il readback prima di un nuovo tentativo.",
  ARUBA_IMPORT_INVALID: "Il file Aruba non è riconosciuto o non coincide con il documento.",
  ARUBA_READ_SESSION_INVALID: "La sessione di sola lettura Aruba non è valida o è scaduta.",
  ARUBA_READ_SESSION_ACTIVE: "Una sincronizzazione Aruba è già attiva per questo account.",
  ARUBA_READ_SESSION_FORBIDDEN: "Solo il titolare può revocare le sessioni Aruba.",
  ARUBA_ACCOUNT_MISMATCH: "L’account Aruba aperto non coincide con quello già collegato.",
  ARUBA_REMOTE_STATUS_UNRECOGNIZED:
    "Aruba mostra troppi stati non riconosciuti; la sincronizzazione è stata fermata.",
  ARUBA_INVENTORY_INVALID: "L’inventario Aruba contiene dati non validi.",
  ARUBA_INVENTORY_INCOMPLETE: "La scansione Aruba non copre tutti gli stream richiesti.",
  ARUBA_INVENTORY_CONFLICT: "Aruba ha restituito dati incompatibili per lo stesso documento.",
  ARUBA_PROFILE_CONFLICT:
    "Il documento Aruba non coincide con il profilo fiscale o con il caso locale.",
  ARUBA_INVENTORY_BLOCKED:
    "L’inventario Aruba non è abbastanza recente o contiene verifiche irrisolte.",
  ARUBA_PREFLIGHT_REQUIRED:
    "È stato richiesto un controllo Aruba aggiornato. Attendi l’helper e riprova entro cinque minuti.",
  INVALID_CONTENT_TYPE: "Formato della richiesta non supportato.",
  REQUEST_BODY_TOO_LARGE: "La richiesta supera il limite consentito.",
  REQUEST_ORIGIN_INVALID: "Origine della richiesta non valida.",
  REQUEST_TIMEOUT: "La richiesta ha impiegato troppo tempo.",
  AUTH_PROVIDER_EXPIRED: "Il collegamento al canale di vendita deve essere rinnovato.",
  AUTH_PROVIDER_ACCOUNT_MISMATCH: "È stato autorizzato un account diverso da quello configurato.",
  PROVIDER_RATE_LIMITED: "Il canale di vendita ha chiesto di rallentare la sincronizzazione.",
  PROVIDER_UNAVAILABLE: "Il canale di vendita non è raggiungibile in questo momento.",
  PROVIDER_RESPONSE_TOO_LARGE: "La risposta del canale di vendita supera il limite previsto.",
  PROVIDER_RESPONSE_INVALID: "Il canale di vendita ha restituito dati non riconosciuti.",
  PROVIDER_NOT_CONFIGURED: "Il collegamento al canale di vendita non è configurato.",
  WEBHOOK_SIGNATURE_INVALID: "La firma del webhook non è valida.",
  UNKNOWN: "Si è verificato un errore inatteso.",
} as const;

export type ErrorCode = keyof typeof errorCatalog;

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;

  constructor(code: ErrorCode, status: number) {
    super(errorCatalog[code]);
    this.code = code;
    this.status = status;
  }
}

export function publicError(error: unknown) {
  if (error instanceof Response) throw error;
  return error instanceof AppError
    ? { code: error.code, message: error.message, status: error.status }
    : { code: "UNKNOWN" as const, message: errorCatalog.UNKNOWN, status: 500 };
}
