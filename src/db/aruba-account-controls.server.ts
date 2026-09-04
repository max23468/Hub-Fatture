import { getPool } from "./client.server.ts";

const EXPIRATION_WARNING_MS = 30 * 24 * 60 * 60_000;

export async function listArubaAccountControlCandidates() {
  const result = await getPool().query<{
    id: string;
    expired: boolean;
    expiration_date: string | null;
    used_space: number | null;
    max_space: number | null;
    checked_at: string;
  }>(
    `SELECT id::text,
            coalesce((account_info_json #>> '{accountStatus,expired}')::boolean, false) AS expired,
            account_info_json #>> '{accountStatus,expirationDate}' AS expiration_date,
            (account_info_json #>> '{usageStatus,usedSpaceKB}')::integer AS used_space,
            (account_info_json #>> '{usageStatus,maxSpaceKB}')::integer AS max_space,
            account_info_checked_at::text AS checked_at
     FROM connections WHERE provider = 'ARUBA' AND account_info_json IS NOT NULL`,
  );
  return result.rows.flatMap((row) => {
    const candidates = [];
    const expirationTime = row.expiration_date ? Date.parse(row.expiration_date) : Number.NaN;
    const expired = row.expired || (Number.isFinite(expirationTime) && expirationTime < Date.now());
    const expirationNear =
      !expired &&
      Number.isFinite(expirationTime) &&
      expirationTime - Date.now() <= EXPIRATION_WARNING_MS;
    if (expired || expirationNear) {
      candidates.push({
        id: `ARUBA_ACCOUNT_EXPIRATION:${row.id}`,
        kind: expired ? "ARUBA_ACCOUNT_EXPIRED" : "ARUBA_ACCOUNT_EXPIRATION_NEAR",
        category: "TECHNICAL" as const,
        severity: expired ? ("BLOCKING" as const) : ("IMPORTANT" as const),
        sourceType: "CONNECTION",
        sourceId: row.id,
        origin: "CONNECTIONS" as const,
        title: expired ? "Account Aruba scaduto o sospeso" : "Scadenza account Aruba vicina",
        detail: row.expiration_date
          ? `Scadenza ${row.expiration_date}`
          : "Stato account da verificare",
        consequence: expired
          ? "Le operazioni Aruba restano bloccate finché l’account non viene ripristinato."
          : "Rinnova l’account prima della scadenza per evitare l’interruzione delle operazioni.",
        href: "/impostazioni#aruba-api",
        primaryAction: "Apri Impostazioni Aruba",
        metadata: { facts: [{ label: "Ultima verifica", value: row.checked_at }] },
        detectedAt: row.checked_at,
      });
    }
    const ratio =
      row.used_space !== null && row.max_space !== null && row.max_space > 0
        ? row.used_space / row.max_space
        : 0;
    if (ratio >= 0.8) {
      const exhausted = ratio >= 1;
      candidates.push({
        id: `ARUBA_ACCOUNT_STORAGE:${row.id}`,
        kind: exhausted ? "ARUBA_ACCOUNT_STORAGE_EXHAUSTED" : "ARUBA_ACCOUNT_STORAGE_NEAR",
        category: "TECHNICAL" as const,
        severity: exhausted ? ("BLOCKING" as const) : ("IMPORTANT" as const),
        sourceType: "CONNECTION",
        sourceId: row.id,
        origin: "CONNECTIONS" as const,
        title: exhausted ? "Spazio Aruba esaurito" : "Spazio Aruba quasi esaurito",
        detail: `${Math.round(ratio * 100)}% dello spazio utilizzato`,
        consequence: exhausted
          ? "Le operazioni Aruba restano bloccate finché non viene liberato o ampliato lo spazio."
          : "Libera o amplia lo spazio prima che i nuovi documenti vengano bloccati.",
        href: "/impostazioni#aruba-api",
        primaryAction: "Apri Impostazioni Aruba",
        metadata: { facts: [{ label: "Ultima verifica", value: row.checked_at }] },
        detectedAt: row.checked_at,
      });
    }
    return candidates;
  });
}
