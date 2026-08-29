export const MIGRATION_FILE_NAME = /^\d{3}_[a-z0-9_]+\.sql$/;

export function sortedMigrationFileNames(names: readonly string[]): string[] {
  return names.filter((name) => MIGRATION_FILE_NAME.test(name)).toSorted();
}

export function latestMigrationFileName(names: readonly string[]): string {
  const latest = sortedMigrationFileNames(names).at(-1);
  if (!latest) throw new Error("Nessuna migrazione SQL valida trovata");
  return latest;
}
