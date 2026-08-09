export const errorCatalog = {
  AUTH_INVALID_CREDENTIALS: "Nome utente o password non validi.",
  AUTH_PASSWORD_POLICY: "La password deve contenere da 8 a 128 caratteri.",
  AUTH_RATE_LIMITED: "Troppi tentativi. Riprova più tardi.",
  AUTH_SETUP_DISABLED: "Gli account sono già configurati.",
  AUTH_INVALID_SETUP_TOKEN: "Codice di configurazione non valido.",
  CONFLICT_REVISION: "I dati sono cambiati. Ricarica la pagina e riprova.",
  ORDER_CURRENCY_NOT_SUPPORTED: "Sono ammessi soltanto ordini in euro.",
  ORDER_INVALID_INPUT: "I dati dell’ordine non sono validi.",
  ORDER_NOT_PREPARABLE:
    "Un ordine annullato o già rimborsato non può essere preparato per la fatturazione.",
  BILLING_CASE_EMPTY: "Una preparazione senza ordini resta archiviata e non può essere riattivata.",
  BILLING_CASE_NOT_EDITABLE:
    "Questa preparazione non è più modificabile nello stato in cui si trova.",
  INVALID_CONTENT_TYPE: "Formato della richiesta non supportato.",
  REQUEST_BODY_TOO_LARGE: "La richiesta supera il limite consentito.",
  REQUEST_ORIGIN_INVALID: "Origine della richiesta non valida.",
  REQUEST_TIMEOUT: "La richiesta ha impiegato troppo tempo.",
  AUTH_PROVIDER_EXPIRED: "Il collegamento al canale di vendita deve essere rinnovato.",
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
