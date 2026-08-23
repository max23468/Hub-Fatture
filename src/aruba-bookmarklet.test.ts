import assert from "node:assert/strict";
import test from "node:test";

import { buildArubaBookmarklet } from "./aruba-bookmarklet.ts";

test("il preferito Aruba è autosufficiente e non contiene credenziali persistenti", () => {
  const bookmarklet = buildArubaBookmarklet({
    hubOrigin: "https://hub.example/percorso-ignorato",
    panelOrigin: "https://fatturazioneelettronica.aruba.it/percorso-ignorato",
  });

  assert.match(bookmarklet, /^javascript:\(async\(\)=>\{/);
  assert.match(bookmarklet, /https:\/\/hub\.example/);
  assert.match(bookmarklet, /https:\/\/fatturazioneelettronica\.aruba\.it/);
  assert.match(bookmarklet, /return"safari"/);
  assert.match(bookmarklet, /BROWSER_UNSUPPORTED/);
  assert.doesNotMatch(bookmarklet, /Bearer |Authorization|hub-fatture-helper:\/\//);
  assert.doesNotThrow(() => new Function(bookmarklet.slice("javascript:".length)));
});
