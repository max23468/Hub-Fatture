import assert from "node:assert/strict";
import test from "node:test";

import { invoiceLinesFromForm } from "./invoice-lines.ts";

test("l'ordinamento visuale non cambia l'ordine fiscale salvato delle righe", () => {
  const form = new URLSearchParams();
  for (const [name, value] of [
    ["documentOrderId", "20"],
    ["documentDescription", "Seconda"],
    ["documentQuantity", "2"],
    ["documentUnitAmount", "20.00"],
    ["documentLinePosition", "1"],
    ["documentOrderId", "10"],
    ["documentDescription", "Prima"],
    ["documentQuantity", "1"],
    ["documentUnitAmount", "10.00"],
    ["documentLinePosition", "0"],
  ]) {
    form.append(name, value);
  }
  assert.deepEqual(invoiceLinesFromForm(form), [
    { orderId: "10", description: "Prima", quantity: 1, unitAmount: 1000 },
    { orderId: "20", description: "Seconda", quantity: 2, unitAmount: 2000 },
  ]);
});

test("le posizioni duplicate o mancanti vengono rifiutate", () => {
  const form = new URLSearchParams({
    documentOrderId: "10",
    documentDescription: "Prima",
    documentQuantity: "1",
    documentUnitAmount: "10.00",
  });
  assert.throws(() => invoiceLinesFromForm(form), /incomplete/i);
  form.append("documentLinePosition", "0");
  form.append("documentOrderId", "20");
  form.append("documentDescription", "Seconda");
  form.append("documentQuantity", "1");
  form.append("documentUnitAmount", "20.00");
  form.append("documentLinePosition", "0");
  assert.throws(() => invoiceLinesFromForm(form), /posizione/i);
});
