import { AppError } from "../errors.ts";

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 8_000;

export async function providerJson(
  url: string,
  init: RequestInit = {},
  { maxBytes = DEFAULT_MAX_BYTES, timeoutMs = DEFAULT_TIMEOUT_MS } = {},
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new AppError("PROVIDER_UNAVAILABLE", 503);
  }
  if (response.status === 401 || response.status === 403)
    throw new AppError("AUTH_PROVIDER_EXPIRED", 401);
  if (response.status === 429) throw new AppError("PROVIDER_RATE_LIMITED", 429);
  if (response.status >= 500) throw new AppError("PROVIDER_UNAVAILABLE", 503);
  if (!response.ok) throw new AppError("PROVIDER_RESPONSE_INVALID", 502);
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new AppError("PROVIDER_RESPONSE_TOO_LARGE", 502);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new AppError("PROVIDER_RESPONSE_INVALID", 502);
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new AppError("PROVIDER_RESPONSE_TOO_LARGE", 502);
    }
    chunks.push(value);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new AppError("PROVIDER_RESPONSE_INVALID", 502);
  }
}
