export const controlSeverities = ["BLOCKING", "IMPORTANT", "ORDINARY"] as const;
export const controlOrigins = [
  "ORDERS",
  "DOCUMENTS",
  "CUSTOMERS",
  "CONNECTIONS",
  "PRIVACY",
] as const;
export const controlWaitingReasons = [
  "PROVIDER",
  "CUSTOMER",
  "ACCOUNTING",
  "TECHNICAL",
  "FOLLOW_UP",
] as const;
