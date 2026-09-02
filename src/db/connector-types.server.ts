export type Provider = "SHOPIFY" | "EBAY";
export type ConnectionEnvironment = "DEVELOPMENT" | "SANDBOX" | "PRODUCTION";

export type JobType =
  | "shopify_sync_orders"
  | "shopify_process_webhook"
  | "ebay_sync_orders"
  | "ebay_preview_history"
  | "process_refund"
  | "send_customer_email"
  | "aruba_backfill_inventory"
  | "aruba_sync_inventory"
  | "aruba_refresh_nonterminal"
  | "aruba_full_inventory"
  | "aruba_dry_run_submission"
  | "aruba_send_submission";

export interface ConnectorActor {
  type: "ADMIN" | "SYSTEM";
  id?: number;
  requestId: string;
}

export interface HistoryImportResult {
  count: number;
  reviewRequired: number;
  imported: number;
  updated: number;
  ignored: number;
}

export interface ClaimedJob {
  id: string;
  type: JobType;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
  workerId: string;
  claimToken: string;
}
