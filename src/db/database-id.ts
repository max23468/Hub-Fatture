const POSTGRES_BIGINT_MAX = "9223372036854775807";

export function isDatabaseId(id: string): boolean {
  return (
    /^[1-9]\d*$/.test(id) &&
    (id.length < POSTGRES_BIGINT_MAX.length ||
      (id.length === POSTGRES_BIGINT_MAX.length && id <= POSTGRES_BIGINT_MAX))
  );
}
