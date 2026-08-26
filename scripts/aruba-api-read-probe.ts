import process from "node:process";

import { AppError } from "../src/errors.ts";
import {
  runArubaApiReadProbe,
  type ArubaApiEnvironment,
} from "../src/integrations/aruba-api.server.ts";

const requiredNames = [
  "ARUBA_API_ENVIRONMENT",
  "ARUBA_API_USERNAME",
  "ARUBA_API_PASSWORD",
  "ARUBA_API_EXPECTED_TAX_ID",
] as const;

function environment(value: string | undefined): ArubaApiEnvironment {
  if (value === "DEMO" || value === "PRODUCTION") return value;
  throw new Error("ARUBA_API_ENVIRONMENT deve essere DEMO o PRODUCTION");
}

function required(name: (typeof requiredNames)[number]): string {
  const value = process.env[name];
  if (!value || (name !== "ARUBA_API_PASSWORD" && !value.trim())) {
    throw new Error(`Variabile richiesta assente: ${name}`);
  }
  return name === "ARUBA_API_PASSWORD" ? value : value.trim();
}

try {
  const result = await runArubaApiReadProbe({
    environment: environment(process.env.ARUBA_API_ENVIRONMENT),
    username: required("ARUBA_API_USERNAME"),
    password: required("ARUBA_API_PASSWORD"),
    expectedTaxId: required("ARUBA_API_EXPECTED_TAX_ID"),
  });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(
    error instanceof Error &&
      /^Variabile richiesta assente:|ARUBA_API_ENVIRONMENT/.test(error.message)
      ? error.message
      : error instanceof AppError
        ? `Probe Aruba fallito: ${error.code}`
        : "Probe Aruba fallito: UNKNOWN",
  );
  process.exitCode = 1;
}
