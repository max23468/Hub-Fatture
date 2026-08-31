import assert from "node:assert/strict";
import test from "node:test";

import { isSearchData } from "./search-data.ts";

const completeResponse = {
  query: "FPR",
  failed: false,
  totals: {
    orders: 1,
    invoices: 1,
    creditNotes: 0,
    customers: 1,
    activities: 0,
    history: 0,
    remoteDocuments: 0,
  },
  orders: [],
  invoices: [],
  creditNotes: [],
  customers: [],
  activities: [],
  history: [],
  remoteDocuments: [],
};

test("accetta soltanto il contratto completo della ricerca globale", () => {
  assert.equal(isSearchData(completeResponse), true);
  assert.equal(
    isSearchData({
      query: "FPR",
      failed: false,
      orders: [],
      documents: [],
      customers: [],
    }),
    false,
  );
  assert.equal(isSearchData({ ...completeResponse, history: undefined }), false);
});
