import { getConfig } from "./config.server.ts";
import { AppError } from "./errors.ts";

export const FORM_BODY_LIMIT = 16 * 1024;
export const FORM_BODY_TIMEOUT_MS = 5_000;
export const WEBHOOK_BODY_LIMIT = 128 * 1024;

const LOOPBACK_SIBLING: Record<string, string> = {
  localhost: "127.0.0.1",
  "127.0.0.1": "localhost",
};

export function securePrivateHeaders(headers: Headers): void {
  headers.set("Cache-Control", "no-store, private");
  const vary = new Set(
    (headers.get("Vary") ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  vary.add("Cookie");
  headers.set("Vary", [...vary].join(", "));
}

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

  const body = await readRawBody(request, { maxBytes, timeoutMs });
  return new URLSearchParams(body.toString("utf8"));
}

export async function readRawBody(
  request: Request,
  { maxBytes = WEBHOOK_BODY_LIMIT, timeoutMs = FORM_BODY_TIMEOUT_MS } = {},
): Promise<Buffer> {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new AppError("REQUEST_BODY_TOO_LARGE", 413);
  }

  const reader = request.body?.getReader();
  if (!reader) return Buffer.alloc(0);

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
      // Niente cancel(): distruggere lo stream in ingresso azzera la connessione prima
      // che la risposta 413 sia scritta, e il client vede un reset invece del codice stabile.
      if (size > maxBytes) throw new AppError("REQUEST_BODY_TOO_LARGE", 413);
      chunks.push(value);
    }
  } finally {
    clearTimeout(timeout);
  }

  return Buffer.concat(chunks, size);
}

export async function readJson(
  request: Request,
  { maxBytes = FORM_BODY_LIMIT, timeoutMs = FORM_BODY_TIMEOUT_MS } = {},
): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";", 1)[0] !== "application/json") {
    throw new AppError("INVALID_CONTENT_TYPE", 415);
  }
  const body = await readRawBody(request, { maxBytes, timeoutMs });
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new AppError("ARUBA_BATCH_INVALID", 422);
  }
}

export async function readMultipartForm(
  request: Request,
  { maxBytes, timeoutMs = FORM_BODY_TIMEOUT_MS }: { maxBytes: number; timeoutMs?: number },
): Promise<FormData> {
  const config = getConfig();
  const origin = request.headers.get("origin");
  if (!origin || !allowedOrigins(config.APP_BASE_URL, config.APP_ENV).has(origin)) {
    throw new AppError("REQUEST_ORIGIN_INVALID", 403);
  }
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data;")) {
    throw new AppError("INVALID_CONTENT_TYPE", 415);
  }
  const body = await readRawBody(request, { maxBytes, timeoutMs });
  try {
    return await new Response(new Uint8Array(body), {
      headers: { "Content-Type": contentType },
    }).formData();
  } catch {
    throw new AppError("ARUBA_IMPORT_INVALID", 422);
  }
}
