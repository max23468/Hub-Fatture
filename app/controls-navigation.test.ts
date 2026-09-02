import assert from "node:assert/strict";
import test from "node:test";

import { controlsActionRedirect } from "./controls-navigation.ts";

test("il redirect di Controlli conserva ricerca, filtri e cursore", () => {
  const requestUrl =
    "https://hub.example/controlli?vista=attesa&gravita=IMPORTANT&origine=ORDERS" +
    "&tipo=ORDER_REVIEW&q=needle-144&cursore=cursor-precedente&id=CONTROL%3A1&esito=vecchio";

  assert.equal(
    controlsActionRedirect(requestUrl, {
      outcome: "attesa",
      selectedControlId: "CONTROL:1",
      state: "WAITING",
    }),
    "/controlli?gravita=IMPORTANT&origine=ORDERS&tipo=ORDER_REVIEW&q=needle-144" +
      "&cursore=cursor-precedente&vista=attesa&id=CONTROL%3A1&esito=attesa",
  );
  assert.equal(
    controlsActionRedirect(requestUrl, {
      outcome: "riaperto",
      selectedControlId: "CONTROL:1",
      state: "OPEN",
    }),
    "/controlli?gravita=IMPORTANT&origine=ORDERS&tipo=ORDER_REVIEW&q=needle-144" +
      "&cursore=cursor-precedente&id=CONTROL%3A1&esito=riaperto",
  );
  assert.equal(
    controlsActionRedirect(requestUrl, { outcome: "completato", state: "OPEN" }),
    "/controlli?gravita=IMPORTANT&origine=ORDERS&tipo=ORDER_REVIEW&q=needle-144" +
      "&cursore=cursor-precedente&esito=completato",
  );
});

test("il redirect di Controlli scarta parametri non riconosciuti", () => {
  assert.equal(
    controlsActionRedirect(
      "https://hub.example/controlli?origine=PRIVACY&ritorno=https://evil.test",
      {
        outcome: "completato",
      },
    ),
    "/controlli?origine=PRIVACY&esito=completato",
  );
});
