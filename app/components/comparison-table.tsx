import { useMemo } from "react";

import { copy } from "../copy.it";
import type { SortValue } from "../table-sort";
import { SortableHeader, useSortableRows } from "./sortable-table";

export interface ComparisonRow {
  field: string;
  source: string;
  draft: string;
  projected: string;
}

type ComparisonSortKey = "field" | "source" | "draft" | "projected";
type DisplayComparisonRow = ComparisonRow & { displayField: string };

function comparisonValue(row: DisplayComparisonRow, key: ComparisonSortKey): SortValue {
  return key === "field" ? row.displayField : row[key];
}

export function ComparisonTable({
  title,
  rows,
  lineLabels = false,
}: {
  title: string;
  rows: ComparisonRow[];
  lineLabels?: boolean;
}) {
  const labels = copy.document.comparisonLabels as Record<string, string>;
  const displayRows = useMemo(
    () =>
      rows.map((row) => ({
        ...row,
        displayField: lineLabels ? copy.document.comparisonLine(row.field) : labels[row.field],
      })),
    [labels, lineLabels, rows],
  );
  const {
    onSort,
    rows: sortedRows,
    sort,
  } = useSortableRows<DisplayComparisonRow, ComparisonSortKey>(
    displayRows,
    { key: "field", direction: "asc" },
    comparisonValue,
  );
  return (
    <section className="comparison-table">
      <h3>{title}</h3>
      <div className="table-wrap">
        <table aria-label={title} className="data-table comparison-data-table">
          <colgroup>
            <col className="comparison-data-table__field" />
            <col />
            <col />
            <col />
          </colgroup>
          <thead>
            <tr>
              <SortableHeader
                label={copy.document.comparisonField}
                onSort={onSort}
                sort={sort}
                sortKey="field"
              />
              <SortableHeader
                label={copy.document.comparisonSource}
                onSort={onSort}
                sort={sort}
                sortKey="source"
              />
              <SortableHeader
                label={copy.document.comparisonDraft}
                onSort={onSort}
                sort={sort}
                sortKey="draft"
              />
              <SortableHeader
                label={copy.document.comparisonProjection}
                onSort={onSort}
                sort={sort}
                sortKey="projected"
              />
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((row) => (
              <tr key={row.field}>
                <th scope="row">{row.displayField}</th>
                <td data-label={copy.document.comparisonSource}>{row.source}</td>
                <td data-label={copy.document.comparisonDraft}>{row.draft}</td>
                <td data-label={copy.document.comparisonProjection}>{row.projected}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
