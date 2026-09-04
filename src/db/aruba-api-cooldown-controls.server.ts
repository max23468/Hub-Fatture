import { getPool } from "./client.server.ts";

const scopeLabels: Record<string, string> = {
  AUTH: "Autenticazione",
  INVOICE_READ: "Lettura fatture",
  NOTIFICATION_READ: "Lettura notifiche",
  SEND: "Trasmissione",
};

export async function listArubaApiCooldownControlCandidates() {
  const result = await getPool().query<{
    api_environment: string;
    scope: string;
    cooldown_until: string;
    last_rate_limited_at: string;
  }>(
    `SELECT api_environment, scope, cooldown_until::text, last_rate_limited_at::text
     FROM aruba_api_traffic_limits
     WHERE cooldown_until > now()
     ORDER BY api_environment, scope`,
  );
  return result.rows.map((row) => ({
    id: `ARUBA_API_COOLDOWN:${row.api_environment}:${row.scope}`,
    kind: "ARUBA_API_COOLDOWN",
    category: "TECHNICAL" as const,
    severity: "IMPORTANT" as const,
    sourceType: "ARUBA_API_TRAFFIC_LIMIT",
    sourceId: `${row.api_environment}:${row.scope}`,
    origin: "CONNECTIONS" as const,
    title: "Aruba ha limitato temporaneamente le richieste",
    detail: `Ripresa prevista dopo ${row.cooldown_until}`,
    consequence:
      "Il worker attende automaticamente senza aggirare il limite o duplicare richieste.",
    href: "/impostazioni#aruba-api",
    primaryAction: "Attendi la ripresa automatica",
    metadata: {
      area: "PROCESSING" as const,
      facts: [
        { label: "Ambiente", value: row.api_environment },
        { label: "Operazione", value: scopeLabels[row.scope] ?? "Richiesta Aruba" },
      ],
    },
    detectedAt: row.last_rate_limited_at,
  }));
}
