import { getConfig } from "./config.server.ts";
import { AppError } from "./errors.ts";

export const FORM_BODY_LIMIT = 16 * 1024;
export const FORM_BODY_TIMEOUT_MS = 5_000;

const LOOPBACK_SIBLING: Record<string, string> = {
  localhost: "127.0.0.1",
  "127.0.0.1": "localhost",
};

// Fuori da Production `localhost` e `127.0.0.1` sono lo stesso host: accettarne uno solo
// significa che aprire lo stack con l'altra forma rende 403 ogni form.
export function allowedOrigins(baseUrl: string, appEnv: string): Set<string> {
  const base = new URL(baseUrl);
  const origins = new Set([base.origin]);
  const sibling = LOOPBACK_SIBLING[base.hostname];
  if (appEnv !== "production" && sibling) {
    const alternative = new URL(base);
    alternative.hostname = sibling;
    origins.add(alternative.origin);
  }
  return origins;
}

export async function readForm(
  request: Request,
  { maxBytes = FORM_BODY_LIMIT, timeoutMs = FORM_BODY_TIMEOUT_MS } = {},
): Promise<URLSearchParams> {
  const config = getConfig();
  const origin = request.headers.get("origin");
  if (!origin || !allowedOrigins(config.APP_BASE_URL, config.APP_ENV).has(origin)) {
    throw new AppError("REQUEST_ORIGIN_INVALID", 403);
  }

  const contentType = request.headers.get("content-type")?.split(";", 1)[0];
  if (contentType !== "application/x-www-form-urlencoded") {
    throw new AppError("INVALID_CONTENT_TYPE", 415);
  }

  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new AppError("REQUEST_BODY_TOO_LARGE", 413);
  }

  const reader = request.body?.getReader();
  if (!reader) return new URLSearchParams();

  const chunks: Uint8Array[] = [];
  let size = 0;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    void reader.cancel();
  }, timeoutMs);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (timedOut) throw new AppError("REQUEST_TIMEOUT", 408);
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new AppError("REQUEST_BODY_TOO_LARGE", 413);
      }
      chunks.push(value);
    }
  } finally {
    clearTimeout(timeout);
  }

  const body = Buffer.concat(chunks, size).toString("utf8");
  return new URLSearchParams(body);
}
