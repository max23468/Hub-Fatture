import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);

export async function hashPassword(value: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = (await scrypt(value, salt, 64)) as Buffer;
  return `scrypt$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

export async function verifyPassword(value: string, encoded: string): Promise<boolean> {
  const [algorithm, saltValue, hashValue] = encoded.split("$");
  if (algorithm !== "scrypt" || !saltValue || !hashValue) return false;
  const expected = Buffer.from(hashValue, "base64url");
  const actual = (await scrypt(
    value,
    Buffer.from(saltValue, "base64url"),
    expected.length,
  )) as Buffer;
  return timingSafeEqual(actual, expected);
}

export function hashToken(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function safeEqual(left: string, right: string): boolean {
  const leftHash = Buffer.from(hashToken(left));
  const rightHash = Buffer.from(hashToken(right));
  return timingSafeEqual(leftHash, rightHash);
}
