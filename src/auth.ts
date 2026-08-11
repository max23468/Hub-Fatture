export const OWNER_USERNAME = "Massimo";
export const AGENT_USERNAME = "Codex";

export function canonicalUsername(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === OWNER_USERNAME.toLowerCase()) return OWNER_USERNAME;
  if (normalized === AGENT_USERNAME.toLowerCase()) return AGENT_USERNAME;
  return null;
}
