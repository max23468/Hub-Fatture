export type SortDirection = "asc" | "desc";

export interface SortState<Key extends string = string> {
  key: Key;
  direction: SortDirection;
}

export type SortValue = string | number | null | undefined;

const italianCollator = new Intl.Collator("it-IT", {
  numeric: true,
  sensitivity: "base",
});

export function nextSortDirection<Key extends string>(
  current: SortState<Key>,
  key: Key,
): SortDirection {
  return current.key === key && current.direction === "asc" ? "desc" : "asc";
}

export function parseSort<Key extends string>(
  key: string | null,
  direction: string | null,
  allowedKeys: readonly Key[],
  fallback: SortState<Key>,
): SortState<Key> {
  if (!allowedKeys.includes(key as Key)) return fallback;
  return {
    key: key as Key,
    direction: direction === "asc" || direction === "desc" ? direction : fallback.direction,
  };
}

function compareValues(
  left: Exclude<SortValue, null | undefined>,
  right: Exclude<SortValue, null | undefined>,
): number {
  if (typeof left === "number" && typeof right === "number") return left - right;
  return italianCollator.compare(String(left), String(right));
}

export function sortRows<T, Key extends string>(
  rows: readonly T[],
  sort: SortState<Key>,
  valueFor: (row: T, key: Key) => SortValue,
): T[] {
  const multiplier = sort.direction === "asc" ? 1 : -1;
  return rows
    .map((row, index) => ({ row, index }))
    .sort((left, right) => {
      const leftValue = valueFor(left.row, sort.key);
      const rightValue = valueFor(right.row, sort.key);
      if (leftValue == null && rightValue == null) return left.index - right.index;
      if (leftValue == null) return 1;
      if (rightValue == null) return -1;
      const comparison = compareValues(leftValue, rightValue);
      return comparison === 0 ? left.index - right.index : comparison * multiplier;
    })
    .map(({ row }) => row);
}

export function sortableUrl(
  searchParams: URLSearchParams,
  keyParam: string,
  directionParam: string,
  key: string,
  direction: SortDirection,
): string {
  const next = new URLSearchParams(searchParams);
  next.set(keyParam, key);
  next.set(directionParam, direction);
  next.delete("pagina");
  return `?${next.toString()}`;
}
