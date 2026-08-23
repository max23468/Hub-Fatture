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
  assert.match(bookmarklet, /Seleziona Fatture inviate/);
  assert.match(bookmarklet, /MutationObserver/);
  assert.match(bookmarklet, /pointerdown/);
  assert.match(bookmarklet, /event\.isTrusted/);
  assert.match(bookmarklet, /state\.requested>0&&monitor\.state\.pending===0/);
  assert.match(bookmarklet, /search\.orderDate/);
  assert.match(bookmarklet, /sync\/heartbeat/);
  assert.match(bookmarklet, /lastFullScanCompletedAt/);
  assert.match(bookmarklet, /overlapFrom/);
  assert.match(bookmarklet, /nonTerminalFrom/);
  assert.match(bookmarklet, /\/api\/aruba\/sync\/termina/);
  assert.doesNotMatch(bookmarklet, /fullScan:true/);
  assert.doesNotMatch(bookmarklet, /Bearer |Authorization|hub-fatture-helper:\/\//);
  assert.doesNotThrow(() => new Function(bookmarklet.slice("javascript:".length)));
});
