import { AppError } from "../errors.ts";

export function parseDatabaseRevision(value: unknown): number {
  const revision = Number(value);
  if (!Number.isInteger(revision) || revision < 0 || revision > 2_147_483_647) {
    throw new AppError("CONFLICT_REVISION", 409);
  }
  return revision;
}
