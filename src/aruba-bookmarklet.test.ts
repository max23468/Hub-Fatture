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
  assert.match(bookmarklet, /characterData:true/);
  assert.match(bookmarklet, /pointerdown/);
  assert.match(bookmarklet, /event\.isTrusted/);
  assert.match(bookmarklet, /const monitor=armReload\(\)/);
  assert.match(bookmarklet, /monitor\.state\.requested===0\|\|monitor\.state\.pending===0/);
  assert.match(bookmarklet, /const next=fingerprint\(\)/);
  assert.match(bookmarklet, /changed=pageIdentity\(\)!==before/);
  assert.match(bookmarklet, /La pagina Aruba non ha completato il caricamento previsto/);
  assert.match(bookmarklet, /sync\/heartbeat/);
  assert.match(bookmarklet, /const fullScan=true/);
  assert.match(bookmarklet, /selectStream\(stream\)/);
  assert.match(bookmarklet, /arubacombobox-filterDate/);
  assert.match(bookmarklet, /ARUBA_FILTER_ACTIVE/);
  assert.doesNotMatch(bookmarklet, /applyDateFilter|input\[name=\\"dataDa\\"\]/);
  assert.match(bookmarklet, /\/api\/aruba\/sync\/termina/);
  assert.doesNotMatch(bookmarklet, /incrementalFrom|preflightFrom/);
  assert.doesNotMatch(bookmarklet, /Bearer |Authorization|hub-fatture-helper:\/\//);
  assert.doesNotThrow(() => new Function(bookmarklet.slice("javascript:".length)));
});
