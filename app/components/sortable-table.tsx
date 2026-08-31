import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";

import { copy } from "../copy.it";
import {
  nextSortDirection,
  sortableUrl,
  sortRows,
  type SortState,
  type SortValue,
} from "../table-sort";

function SortIcon({ direction }: { direction: SortState["direction"] | null }) {
  const Icon = direction === "asc" ? ArrowUp : direction === "desc" ? ArrowDown : ChevronsUpDown;
  return <Icon aria-hidden="true" size={15} strokeWidth={2} />;
}

function ariaSort(direction: SortState["direction"] | null) {
  return direction === "asc" ? "ascending" : direction === "desc" ? "descending" : "none";
}

export function SortableHeader<Key extends string>({
  className,
  label,
  onSort,
  sort,
  sortKey,
}: {
  className?: string;
  label: string;
  onSort: (key: Key) => void;
  sort: SortState<Key>;
  sortKey: Key;
}) {
  const direction = sort.key === sortKey ? sort.direction : null;
  return (
    <th aria-sort={ariaSort(direction)} className={className} scope="col">
      <button
        aria-label={copy.table.sortLabel(label, direction)}
        className="table-sort-button"
        onClick={() => onSort(sortKey)}
        type="button"
      >
        <span>{label}</span>
        <SortIcon direction={direction} />
      </button>
    </th>
  );
}

export function SortableHeaderLink<Key extends string>({
  className,
  directionParam,
  keyParam,
  label,
  sort,
  sortKey,
}: {
  className?: string;
  directionParam: string;
  keyParam: string;
  label: string;
  sort: SortState<Key>;
  sortKey: Key;
}) {
  const direction = sort.key === sortKey ? sort.direction : null;
  return (
    <th aria-sort={ariaSort(direction)} className={className} scope="col">
      <SortControlLink
        directionParam={directionParam}
        keyParam={keyParam}
        label={label}
        sort={sort}
        sortKey={sortKey}
      />
    </th>
  );
}

export function SortControlLink<Key extends string>({
  className,
  directionParam,
  keyParam,
  label,
  sort,
  sortKey,
}: {
  className?: string;
  directionParam: string;
  keyParam: string;
  label: string;
  sort: SortState<Key>;
  sortKey: Key;
}) {
  const [searchParams] = useSearchParams();
  const direction = sort.key === sortKey ? sort.direction : null;
  return (
    <Link
      aria-label={copy.table.sortLabel(label, direction)}
      className={["table-sort-button", className].filter(Boolean).join(" ")}
      preventScrollReset
      to={sortableUrl(
        searchParams,
        keyParam,
        directionParam,
        sortKey,
        nextSortDirection(sort, sortKey),
      )}
      viewTransition
    >
      <span>{label}</span>
      <SortIcon direction={direction} />
    </Link>
  );
}

export function useSortableRows<T, Key extends string>(
  rows: readonly T[],
  initialSort: SortState<Key>,
  valueFor: (row: T, key: Key) => SortValue,
) {
  const [sort, setSort] = useState(initialSort);
  const sortedRows = useMemo(() => sortRows(rows, sort, valueFor), [rows, sort, valueFor]);
  const onSort = (key: Key) => {
    setSort((current) => ({ key, direction: nextSortDirection(current, key) }));
  };
  return { onSort, rows: sortedRows, sort };
}
