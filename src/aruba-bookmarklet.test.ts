import assert from "node:assert/strict";
import test from "node:test";

import { buildArubaBookmarklet, buildArubaBookmarkletRuntime } from "./aruba-bookmarklet.ts";

test("il preferito Aruba carica il lettore corrente senza contenere credenziali persistenti", () => {
  const bookmarklet = buildArubaBookmarklet({
    hubOrigin: "https://hub.example/percorso-ignorato",
    panelOrigin: "https://fatturazioneelettronica.aruba.it/percorso-ignorato",
  });

  assert.match(bookmarklet, /^javascript:\(\(\)=>\{/);
  assert.match(bookmarklet, /https:\/\/hub\.example/);
  assert.match(bookmarklet, /https:\/\/fatturazioneelettronica\.aruba\.it/);
  assert.match(bookmarklet, /runtimeSource/);
  assert.match(bookmarklet, /__HUB_FATTURE_ARUBA_BRIDGE__/);
  assert.match(bookmarklet, /document\.createElement\("script"\)/);
  assert.match(bookmarklet, /RUNTIME_BLOCKED/);
  assert.doesNotMatch(bookmarklet, /\beval\s*\(|new Function/);
  assert.doesNotMatch(bookmarklet, /MutationObserver|sync\/pagine|ARUBA_ACCOUNT_MISMATCH/);
  assert.doesNotMatch(bookmarklet, /Bearer |Authorization|hub-fatture-helper:\/\//);
  assert.doesNotThrow(() => new Function(bookmarklet.slice("javascript:".length)));
});

test("il lettore Aruba corrente conserva le guardie della sincronizzazione", () => {
  const runtime = buildArubaBookmarkletRuntime({
    hubOrigin: "https://hub.example",
    panelOrigin: "https://fatturazioneelettronica.aruba.it",
  });

  assert.match(runtime, /return"safari"/);
  assert.match(runtime, /bridge=bridge\|\|open/);
  assert.match(runtime, /const closeBridge=.*bridge\?\.close/);
  assert.match(runtime, /removeEventListener\("message",onMessage\);\s*closeBridge\(\)/);
  assert.doesNotMatch(runtime, /HF_ARUBA_HELLO|HF_ARUBA_START|waitForStart/);
  assert.match(runtime, /BROWSER_UNSUPPORTED/);
  assert.match(runtime, /Seleziona Fatture inviate/);
  assert.match(runtime, /MutationObserver/);
  assert.match(runtime, /characterData:true/);
  assert.match(runtime, /pointerdown/);
  assert.match(runtime, /event\.isTrusted/);
  assert.match(runtime, /const monitor=armReload\(\)/);
  assert.match(runtime, /monitor\.state\.requested===0\|\|monitor\.state\.pending===0/);
  assert.match(runtime, /const next=fingerprint\(\)/);
  assert.match(runtime, /changed=pageIdentity\(\)!==before/);
  assert.match(runtime, /La pagina Aruba non ha completato il caricamento previsto/);
  assert.match(runtime, /sync\/heartbeat/);
  assert.match(runtime, /const fullScan=true/);
  assert.match(runtime, /selectStream\(stream\)/);
  assert.match(runtime, /arubacombobox-filterDate/);
  assert.match(runtime, /ARUBA_FILTER_ACTIVE/);
  assert.match(runtime, /sync\/verifica-account/);
  assert.match(runtime, /if\(!accountVerified\)fail\("ARUBA_ACCOUNT_MISMATCH"\)/);
  assert.doesNotMatch(runtime, /main-toolbar-info-user|data-aruba-account/);
  assert.doesNotMatch(runtime, /applyDateFilter|input\[name=\\"dataDa\\"\]/);
  assert.match(runtime, /\/api\/aruba\/sync\/termina/);
  assert.doesNotMatch(runtime, /incrementalFrom|preflightFrom/);
  assert.doesNotMatch(runtime, /Bearer |Authorization|hub-fatture-helper:\/\//);
  assert.doesNotThrow(() => new Function(runtime));
});
