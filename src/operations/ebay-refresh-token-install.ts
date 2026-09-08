import { randomUUID } from "node:crypto";

import { closePool } from "../db/client.server.ts";
import { installEbayRefreshToken } from "../integrations/ebay.server.ts";

const MAX_TOKEN_BYTES = 16 * 1024;

async function readRefreshToken() {
  if (process.stdin.isTTY) throw new Error("EBAY_REFRESH_TOKEN_STDIN_REQUIRED");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_TOKEN_BYTES) throw new Error("EBAY_REFRESH_TOKEN_INVALID");
    chunks.push(buffer);
  }
  const input = Buffer.concat(chunks);
  const refreshToken = input.toString("utf8").trim();
  input.fill(0);
  for (const chunk of chunks) chunk.fill(0);
  if (!refreshToken || /[\r\n]/.test(refreshToken)) throw new Error("EBAY_REFRESH_TOKEN_INVALID");
  return refreshToken;
}

try {
  await installEbayRefreshToken(await readRefreshToken(), {
    type: "SYSTEM",
    requestId: randomUUID(),
  });
  process.stdout.write("Refresh token eBay verificato e installato.\n");
} catch {
  process.stderr.write("Installazione del refresh token eBay non riuscita.\n");
  process.exitCode = 1;
} finally {
  await closePool();
}
