import { AppError } from "../src/errors.ts";

export function parseArubaManualPagesJson(value: FormDataEntryValue | null): unknown {
  try {
    return JSON.parse(String(value ?? "null")) as unknown;
  } catch {
    throw new AppError("ARUBA_INVENTORY_INVALID", 422);
  }
}
