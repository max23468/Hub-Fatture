import process from "node:process";

import { AppError } from "../src/errors.ts";
import {
  runArubaApiReadProbe,
  type ArubaApiEnvironment,
} from "../src/integrations/aruba-api.server.ts";

const requiredNames = [
  "ARUBA_API_ENVIRONMENT",
  "ARUBA_API_USERNAME",
  "ARUBA_API_EXPECTED_TAX_ID",
] as const;

function environment(value: string | undefined): ArubaApiEnvironment {
  if (value === "DEMO" || value === "PRODUCTION") return value;
  throw new Error("ARUBA_API_ENVIRONMENT deve essere DEMO o PRODUCTION");
}

function required(name: (typeof requiredNames)[number]): string {
  const value = process.env[name];
  if (!value?.trim()) {
    throw new Error(`Variabile richiesta assente: ${name}`);
  }
  return value.trim();
}

async function passwordFromStdin(): Promise<string> {
  if (process.stdin.isTTY) throw new Error("Password Aruba richiesta tramite stdin");

  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > 1_024) throw new Error("Password Aruba non valida");
    chunks.push(buffer);
  }

  const password = Buffer.concat(chunks)
    .toString("utf8")
    .replace(/\r?\n$/, "");
  if (!password || /[\0\r\n]/.test(password)) throw new Error("Password Aruba non valida");
  return password;
}

try {
  const password = await passwordFromStdin();
  const result = await runArubaApiReadProbe({
    environment: environment(process.env.ARUBA_API_ENVIRONMENT),
    username: required("ARUBA_API_USERNAME"),
    password,
    expectedTaxId: required("ARUBA_API_EXPECTED_TAX_ID"),
  });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(
    error instanceof Error &&
      /^(?:Variabile richiesta assente:|ARUBA_API_ENVIRONMENT|Password Aruba)/.test(error.message)
      ? error.message
      : error instanceof AppError
        ? `Probe Aruba fallito: ${error.code}`
        : "Probe Aruba fallito: UNKNOWN",
  );
  process.exitCode = 1;
}
