import assert from "node:assert/strict";
import test from "node:test";

import { historicalInvoiceInput } from "./historical-invoice-projection.server.ts";

test("la proiezione storica usa le righe dello snapshot immutabile", () => {
  const input = historicalInvoiceInput({
    kind: "INVOICE",
    documentDate: "2026-08-16",
    recipient: {
      kind: "PRIVATE_IT",
      firstName: "Mario",
      lastName: "Rossi",
      taxIdentifiers: [
        { type: "CODICE_FISCALE", value: "RSSMRA80A01H501U", countryCode: "IT" },
      ],
      address: {
        line1: "Via Cliente 2",
        postalCode: "00100",
        city: "Roma",
        province: "RM",
        countryCode: "IT",
      },
    },
    lines: [
      {
        description: "Linea esterna",
        quantity: 1,
        unitAmount: 2500,
      },
    ],
    paymentStatus: "PAID",
    paymentMethod: "MP08",
  });

  assert.deepEqual(input.lines, [
    {
      description: "Linea esterna",
      quantity: 1,
      unitAmount: 2500,
    },
  ]);
});
