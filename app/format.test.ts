import assert from "node:assert/strict";
import test from "node:test";

import { address, dateTime } from "./format.ts";

test("formatta i timestamp nel fuso Europe/Rome", () => {
  assert.match(dateTime("2026-03-29T00:30:00Z"), /01:30/);
});

test("rende l’indirizzo con il nome del Paese", () => {
  assert.equal(
    address({
      line1: "Via Esempio 1",
      postalCode: "20100",
      city: "Milano",
      province: "MI",
      countryCode: "IT",
    }),
    "Via Esempio 1, 20100 Milano, MI, Italia",
  );
});
