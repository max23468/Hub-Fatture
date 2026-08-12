import assert from "node:assert/strict";
import test from "node:test";

import { address, compactDate, compactDateTime, dateTime, isoDateTime } from "./format.ts";

test("formatta i timestamp nel fuso Europe/Rome", () => {
  assert.match(dateTime("2026-03-29T00:30:00Z"), /01:30/);
});

test("formatta date compatte senza perdere l'anno", () => {
  assert.equal(compactDate("2026-08-08"), "08/08/2026");
  assert.equal(compactDateTime("2026-08-12T12:23:00Z"), "12/08/2026, 14:23");
});

test("normalizza in ISO gli attributi datetime ricevuti dal loader", () => {
  assert.equal(isoDateTime("2026-08-12T12:23:00Z"), "2026-08-12T12:23:00.000Z");
  assert.equal(isoDateTime(new Date("2026-08-12T12:23:00Z")), "2026-08-12T12:23:00.000Z");
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
