import type { loader } from "./routes/search";

export type SearchData = Awaited<ReturnType<typeof loader>>["data"];

const resultKeys = [
  "orders",
  "invoices",
  "creditNotes",
  "customers",
  "controls",
  "history",
  "remoteDocuments",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isSearchData(value: unknown): value is SearchData {
  if (!isRecord(value) || typeof value.query !== "string" || typeof value.failed !== "boolean") {
    return false;
  }
  const totals = value.totals;
  if (!isRecord(totals)) return false;
  return resultKeys.every((key) => Array.isArray(value[key]) && typeof totals[key] === "number");
}
