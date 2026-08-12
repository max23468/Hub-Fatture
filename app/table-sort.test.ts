import assert from "node:assert/strict";
import test from "node:test";

import { nextSortDirection, parseSort, sortableUrl, sortRows } from "./table-sort.ts";

test("l'ordinamento tabellare è stabile, numerico e mette i valori assenti in fondo", () => {
  const rows = [
    { id: "a", value: "Voce 10" },
    { id: "b", value: null },
    { id: "c", value: "voce 2" },
    { id: "d", value: "Voce 2" },
  ];
  assert.deepEqual(
    sortRows(rows, { key: "value", direction: "asc" }, (row) => row.value).map(({ id }) => id),
    ["c", "d", "a", "b"],
  );
  assert.deepEqual(
    sortRows(rows, { key: "value", direction: "desc" }, (row) => row.value).map(({ id }) => id),
    ["a", "c", "d", "b"],
  );
});

test("i parametri di ordinamento sono validati e azzerano la pagina", () => {
  const fallback = { key: "data" as const, direction: "desc" as const };
  assert.deepEqual(parseSort("cliente", "asc", ["data", "cliente"] as const, fallback), {
    key: "cliente",
    direction: "asc",
  });
  assert.deepEqual(
    parseSort("query-non-valida", "asc", ["data", "cliente"] as const, fallback),
    fallback,
  );
  assert.equal(nextSortDirection({ key: "data", direction: "asc" }, "data"), "desc");
  assert.equal(nextSortDirection({ key: "data", direction: "desc" }, "cliente"), "asc");
  assert.equal(
    sortableUrl(
      new URLSearchParams("vista=cronologia&pagina=3"),
      "ordina",
      "direzione",
      "cliente",
      "asc",
    ),
    "?vista=cronologia&ordina=cliente&direzione=asc",
  );
});
