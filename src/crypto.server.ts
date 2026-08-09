import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  type ScryptOptions,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";

// promisify perde l’overload con opzioni: senza questo tipo i parametri di costo non compilano.
const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

// Il costo resta scritto in ogni hash: alzarlo non invalida silenziosamente i precedenti.
const COST = { N: 16_384, r: 8, p: 1 } as const;
const KEY_LENGTH = 64;

export async function hashPassword(value: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(value, salt, KEY_LENGTH, {
    ...COST,
    maxmem: 256 * COST.N * COST.r,
  });
  return `scrypt$${COST.N}$${COST.r}$${COST.p}$${salt.toString("base64url")}$${derived.toString(
    "base64url",
  )}`;
}

export async function verifyPassword(value: string, encoded: string): Promise<boolean> {
  const [algorithm, cost, blockSize, parallel, saltValue, hashValue] = encoded.split("$");
  if (algorithm !== "scrypt" || !saltValue || !hashValue) return false;
  const N = Number(cost);
  const r = Number(blockSize);
  const p = Number(parallel);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  const expected = Buffer.from(hashValue, "base64url");
  if (expected.length !== KEY_LENGTH) return false;
  const actual = await scrypt(value, Buffer.from(saltValue, "base64url"), KEY_LENGTH, {
    N,
    r,
    p,
    maxmem: 256 * N * r,
  });
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

function encryptionKey(value: string): Buffer {
  const key = Buffer.from(value, "base64url");
  if (key.length !== 32) throw new Error("Chiave cifratura credenziali non valida");
  return key;
}

export function encryptCredential(value: unknown, keyValue: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(keyValue), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString("base64url")).join(".");
}

export function decryptCredential<T>(value: string, keyValue: string): T {
  const [ivValue, tagValue, ciphertextValue] = value.split(".");
  if (!ivValue || !tagValue || !ciphertextValue) throw new Error("Credenziale cifrata non valida");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(keyValue),
    Buffer.from(ivValue, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  return JSON.parse(
    Buffer.concat([
      decipher.update(Buffer.from(ciphertextValue, "base64url")),
      decipher.final(),
    ]).toString("utf8"),
  ) as T;
}
