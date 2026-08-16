import type { APIResponse, BrowserContext } from "playwright";

import {
  ARUBA_PANEL_ORIGIN,
  ARUBA_UPLOAD_MAX_BYTES,
  assertAllowedArubaDownload,
} from "../src/aruba.ts";

async function browserHeaders(context: BrowserContext, url: URL) {
  const cookies = await context.cookies(url.toString());
  const page = context.pages()[0];
  const userAgent = page
    ? await page.evaluate(() => navigator.userAgent).catch(() => undefined)
    : undefined;
  return {
    ...(cookies.length
      ? { Cookie: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ") }
      : {}),
    ...(userAgent ? { "User-Agent": userAgent } : {}),
    ...(page?.url() && page.url() !== "about:blank" ? { Referer: page.url() } : {}),
    Accept: "*/*",
  };
}

export async function readBoundedResponse(
  response: Response,
  maxBytes = ARUBA_UPLOAD_MAX_BYTES,
): Promise<Buffer> {
  if (!response.ok || !response.body) throw new Error("OFFICIAL_FILE_DOWNLOAD_FAILED");
  const advertised = Number(response.headers.get("content-length"));
  if (Number.isFinite(advertised) && advertised > maxBytes) {
    await response.body.cancel().catch(() => undefined);
    throw new Error("OFFICIAL_FILE_DOWNLOAD_FAILED");
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      size += chunk.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("OFFICIAL_FILE_DOWNLOAD_FAILED");
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  if (!size) throw new Error("OFFICIAL_FILE_DOWNLOAD_FAILED");
  return Buffer.concat(chunks, size);
}

async function downloadArubaResponse(context: BrowserContext, rawUrl: string) {
  const target = new URL(`${ARUBA_PANEL_ORIGIN}/`);
  let current = assertAllowedArubaDownload(rawUrl, target);
  for (let redirect = 0; redirect <= 5; redirect += 1) {
    const response = await fetch(current, {
      headers: await browserHeaders(context, current),
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || redirect === 5) throw new Error("OFFICIAL_FILE_DOWNLOAD_FAILED");
      await response.body?.cancel().catch(() => undefined);
      current = assertAllowedArubaDownload(new URL(location, current).toString(), target);
      continue;
    }
    return { status: response.status, body: await readBoundedResponse(response) };
  }
  throw new Error("OFFICIAL_FILE_DOWNLOAD_FAILED");
}

export function installBoundedArubaRequestGet(context: BrowserContext) {
  const request = context.request;
  const originalGet = request.get.bind(request);
  request.get = (async (url: string, options?: Parameters<typeof request.get>[1]) => {
    const candidate = new URL(url);
    if (candidate.origin !== ARUBA_PANEL_ORIGIN) return originalGet(url, options);
    const response = await downloadArubaResponse(context, candidate.toString());
    return {
      ok: () => response.status >= 200 && response.status < 300,
      body: async () => response.body,
    } as APIResponse;
  }) as typeof request.get;
}
