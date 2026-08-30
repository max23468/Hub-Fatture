import { expect, test } from "@playwright/test";

import { appBaseUrl } from "./support.ts";

test("le mutazioni senza origine valida non raggiungono l’azione", async ({ request }) => {
  const headers = { origin: "http://attaccante.invalid" };

  // Route risorsa: la guardia applicativa deve rispondere con il codice del registro,
  // non con un 500 generico.
  const logout = await request.post("/logout", {
    form: { csrf: "assente" },
    headers,
  });
  expect(logout.status()).toBe(403);
  expect(await logout.json()).toMatchObject({
    code: "REQUEST_ORIGIN_INVALID",
  });

  // Route documento: React Router rifiuta la richiesta cross-origin prima dell'azione.
  const login = await request.post("/login", {
    form: { username: "massimo", password: "password-massimo" },
    headers,
  });
  expect(login.status()).toBeGreaterThanOrEqual(400);
  expect(login.status()).toBeLessThan(500);
});

test("gli errori delle azioni restano codici stabili, non 500", async ({ request }) => {
  const headers = { origin: appBaseUrl };
  expect((await request.post("/logout", { form: { csrf: "x" } })).status()).toBe(403);
  expect((await request.post("/login", { headers, data: { username: "Massimo" } })).status()).toBe(
    415,
  );

  await request.post("/login", {
    headers,
    form: { username: "MASSIMO", password: "password-massimo" },
  });
  expect((await request.post("/logout", { headers, form: { csrf: "sbagliato" } })).status()).toBe(
    403,
  );
  expect((await request.post("/logout", { headers, form: { csrf: "x" } })).status()).toBe(403);
});

test("le risposte dichiarano gli header di sicurezza minimi", async ({ request }) => {
  const headers = (await request.get("/login")).headers();
  expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["referrer-policy"]).toBe("same-origin");
  expect(headers["x-robots-tag"]).toBe("noindex, nofollow, noarchive, nosnippet, noimageindex");
  expect(headers["cache-control"]).toBe("no-store, private");

  const robots = await request.get("/robots.txt");
  expect(robots.headers()["content-type"]).toContain("text/plain");
  expect(await robots.text()).toBe("User-agent: *\nDisallow: /\n");
  expect(robots.headers()["x-robots-tag"]).toBe(
    "noindex, nofollow, noarchive, nosnippet, noimageindex",
  );

  await request.post("/login", {
    headers: { origin: appBaseUrl },
    form: { username: "mAsSiMo", password: "password-massimo" },
  });
  const dataHeaders = (await request.get("/ordini.data")).headers();
  expect(dataHeaders["cache-control"]).toBe("no-store, private");
  expect(dataHeaders.vary).toContain("Cookie");
});
