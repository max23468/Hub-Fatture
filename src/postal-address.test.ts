import assert from "node:assert/strict";
import test from "node:test";

import { splitPostalAddress } from "./postal-address.ts";

test("separa il civico italiano dal toponimo", () => {
  assert.deepEqual(splitPostalAddress({ line1: "Via 11 Settembre 10", postalCode: "50100" }), {
    line1: "Via 11 Settembre",
    streetNumber: "10",
    line2: undefined,
  });
  assert.deepEqual(
    splitPostalAddress({ line1: "Strada Provinciale 12 Campo Distante 99/B", postalCode: "00100" }),
    {
      line1: "Strada Provinciale 12 Campo Distante",
      streetNumber: "99/B",
      line2: undefined,
    },
  );
});

test("separa il civico iniziale estero senza confonderlo con il toponimo", () => {
  assert.deepEqual(
    splitPostalAddress({ line1: "12 Rue Bataille 8 Mai 1945", postalCode: "75001" }),
    { line1: "Rue Bataille 8 Mai 1945", streetNumber: "12", line2: undefined },
  );
  assert.deepEqual(splitPostalAddress({ line1: "Rue du 8 Mai 1945", postalCode: "75001" }), {
    line1: "Rue du 8 Mai 1945",
    line2: undefined,
  });
});

test("usa la seconda riga come civico solo quando è strutturalmente univoca", () => {
  assert.deepEqual(
    splitPostalAddress({
      line1: "Strada Provinciale 12",
      line2: "5",
      postalCode: "00100",
    }),
    { line1: "Strada Provinciale 12", streetNumber: "5" },
  );
  assert.deepEqual(
    splitPostalAddress({ line1: "Via Roma 10", line2: "Interno 2", postalCode: "00100" }),
    { line1: "Via Roma", line2: "Interno 2", streetNumber: "10" },
  );
});

test("non inventa un civico quando l'indirizzo è ambiguo", () => {
  assert.deepEqual(splitPostalAddress({ line1: "SP 12", postalCode: "00100" }), {
    line1: "SP 12",
    line2: undefined,
  });
  assert.deepEqual(splitPostalAddress({ line1: "National Road N 7", postalCode: "10001" }), {
    line1: "National Road N 7",
    line2: undefined,
  });
});
