import assert from "node:assert/strict";
import test from "node:test";

import { AppError } from "../errors.ts";
import { runArubaApiReadProbe } from "./aruba-api.server.ts";

const NOW = new Date("2026-08-26T12:00:00.000Z");

function response(value: unknown): Response {
  return Response.json(value);
}

test("il probe Production autentica l'utenza Base e usa soltanto letture API", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  try {
    globalThis.fetch = async (input, init = {}) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith("/auth/signin")) {
        assert.equal(new URL(url).search, "");
        assert.equal(init.method, "POST");
        assert.equal(
          String(init.body),
          "grant_type=password&username=utente-sintetico&password=password-sintetica",
        );
        return response({ access_token: "token-sintetico", expires_in: 1800 });
      }
      if (url.endsWith("/auth/userInfo")) {
        return response({
          username: "utente-sintetico",
          vatCode: "00000000000",
          fiscalCode: "00000000000",
          accountStatus: { expired: false, expirationDate: "2027-08-26" },
        });
      }
      assert.equal(new URL(url).origin, "https://ws.fatturazioneelettronica.aruba.it");
      assert.equal(new URL(url).pathname, "/api/v2/invoices-out");
      assert.equal(new URL(url).searchParams.get("page"), "1");
      assert.equal(new URL(url).searchParams.get("size"), "10");
      assert.equal(init.method, undefined);
      return response({
        content: [],
        numberOfElements: 0,
        totalElements: 0,
        totalPages: 0,
      });
    };

    assert.deepEqual(
      await runArubaApiReadProbe({
        environment: "PRODUCTION",
        username: "utente-sintetico",
        password: "password-sintetica",
        expectedTaxId: "IT00000000000",
        now: NOW,
      }),
      {
        status: "ok",
        environment: "PRODUCTION",
        accountVerified: true,
        accountExpired: false,
        outboundReadAuthorized: true,
        requestedPages: 1,
        returnedInvoiceGroups: 0,
        totalInvoiceGroups: 0,
        completeWindowRead: true,
        windowStart: "2026-08-25T12:00:00.000Z",
        windowEnd: "2026-08-26T12:00:00.000Z",
      },
    );
    assert.equal(calls.length, 3);
    assert.deepEqual(
      calls.slice(1).map((call) => new Headers(call.init.headers).get("authorization")),
      ["Bearer token-sintetico", "Bearer token-sintetico"],
    );
    assert.equal(
      calls.some((call) => /upload|send/i.test(new URL(call.url).pathname)),
      false,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("il probe Demo resta confinato agli host Demo ufficiali", async () => {
  const originalFetch = globalThis.fetch;
  const origins: string[] = [];
  try {
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      origins.push(url.origin);
      if (url.pathname === "/auth/signin") {
        return response({ access_token: "token-demo", expires_in: 1800 });
      }
      if (url.pathname === "/auth/userInfo") {
        return response({
          username: "demo",
          vatCode: "00000000000",
          fiscalCode: null,
          accountStatus: { expired: false, expirationDate: null },
        });
      }
      return response({
        content: [],
        numberOfElements: 0,
        totalElements: 0,
        totalPages: 0,
      });
    };
    await runArubaApiReadProbe({
      environment: "DEMO",
      username: "demo",
      password: "password-sintetica",
      expectedTaxId: "00000000000",
      now: NOW,
    });
    assert.deepEqual(origins, [
      "https://demoauth.fatturazioneelettronica.aruba.it",
      "https://demoauth.fatturazioneelettronica.aruba.it",
      "https://demows.fatturazioneelettronica.aruba.it",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("il probe legge due pagine limitate senza materializzare dettagli o file", async () => {
  const originalFetch = globalThis.fetch;
  const searchedPages: string[] = [];
  try {
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/auth/signin") {
        return response({ access_token: "token-sintetico", expires_in: 1800 });
      }
      if (url.pathname === "/auth/userInfo") {
        return response({
          username: "utente-sintetico",
          vatCode: "00000000000",
          fiscalCode: null,
          accountStatus: { expired: false, expirationDate: null },
        });
      }
      const page = url.searchParams.get("page")!;
      searchedPages.push(page);
      const count = page === "1" ? 10 : 3;
      return response({
        content: Array.from({ length: count }, (_, index) => ({ ignored: `${page}-${index}` })),
        numberOfElements: count,
        totalElements: 13,
        totalPages: 2,
      });
    };

    const result = await runArubaApiReadProbe({
      environment: "PRODUCTION",
      username: "utente-sintetico",
      password: "password-sintetica",
      expectedTaxId: "00000000000",
      now: NOW,
    });
    assert.deepEqual(searchedPages, ["1", "2"]);
    assert.equal(result.requestedPages, 2);
    assert.equal(result.returnedInvoiceGroups, 13);
    assert.equal(result.totalInvoiceGroups, 13);
    assert.equal(result.completeWindowRead, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("il probe limita la lettura a due pagine e dichiara la finestra incompleta", async () => {
  const originalFetch = globalThis.fetch;
  let searchedPages = 0;
  try {
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/auth/signin") {
        return response({ access_token: "token-sintetico", expires_in: 1800 });
      }
      if (url.pathname === "/auth/userInfo") {
        return response({
          username: "utente-sintetico",
          vatCode: "00000000000",
          fiscalCode: null,
          accountStatus: { expired: false, expirationDate: null },
        });
      }
      searchedPages += 1;
      return response({
        content: Array.from({ length: 10 }, () => ({})),
        numberOfElements: 10,
        totalElements: 31,
        totalPages: 4,
      });
    };

    const result = await runArubaApiReadProbe({
      environment: "PRODUCTION",
      username: "utente-sintetico",
      password: "password-sintetica",
      expectedTaxId: "00000000000",
      now: NOW,
    });
    assert.equal(searchedPages, 2);
    assert.equal(result.returnedInvoiceGroups, 20);
    assert.equal(result.totalInvoiceGroups, 31);
    assert.equal(result.completeWindowRead, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("il probe rifiuta metadati di paginazione incoerenti", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/auth/signin") {
        return response({ access_token: "token-sintetico", expires_in: 1800 });
      }
      if (url.pathname === "/auth/userInfo") {
        return response({
          username: "utente-sintetico",
          vatCode: "00000000000",
          fiscalCode: null,
          accountStatus: { expired: false, expirationDate: null },
        });
      }
      return response({
        content: [{}],
        numberOfElements: 2,
        totalElements: 1,
        totalPages: 1,
      });
    };

    await assert.rejects(
      runArubaApiReadProbe({
        environment: "PRODUCTION",
        username: "utente-sintetico",
        password: "password-sintetica",
        expectedTaxId: "00000000000",
        now: NOW,
      }),
      (error) => error instanceof AppError && error.code === "PROVIDER_RESPONSE_INVALID",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("il probe si arresta prima della lettura se l'identità Aruba non coincide", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async (input) => {
      calls += 1;
      const url = new URL(String(input));
      if (url.pathname === "/auth/signin") {
        return response({ access_token: "token-sintetico", expires_in: 1800 });
      }
      return response({
        username: "utente-sintetico",
        vatCode: "11111111111",
        fiscalCode: null,
        accountStatus: { expired: false, expirationDate: null },
      });
    };
    await assert.rejects(
      runArubaApiReadProbe({
        environment: "PRODUCTION",
        username: "utente-sintetico",
        password: "password-sintetica",
        expectedTaxId: "00000000000",
        now: NOW,
      }),
      (error) => error instanceof AppError && error.code === "AUTH_PROVIDER_ACCOUNT_MISMATCH",
    );
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("il probe rifiuta un'identità attesa che non sia P.IVA o codice fiscale", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async (input) => {
      calls += 1;
      const url = new URL(String(input));
      if (url.pathname === "/auth/signin") {
        return response({ access_token: "token-sintetico", expires_in: 1800 });
      }
      return response({
        username: "utente-sintetico",
        vatCode: "IDENTITA-NON-VALIDA",
        fiscalCode: null,
        accountStatus: { expired: false, expirationDate: null },
      });
    };
    await assert.rejects(
      runArubaApiReadProbe({
        environment: "PRODUCTION",
        username: "utente-sintetico",
        password: "password-sintetica",
        expectedTaxId: "IDENTITA-NON-VALIDA",
        now: NOW,
      }),
      (error) => error instanceof AppError && error.code === "AUTH_PROVIDER_ACCOUNT_MISMATCH",
    );
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("il probe si arresta se Aruba segnala l'account scaduto", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/auth/signin") {
        return response({ access_token: "token-sintetico", expires_in: 1800 });
      }
      return response({
        username: "utente-sintetico",
        vatCode: "00000000000",
        fiscalCode: null,
        accountStatus: { expired: true, expirationDate: "2026-08-25" },
      });
    };
    await assert.rejects(
      runArubaApiReadProbe({
        environment: "PRODUCTION",
        username: "utente-sintetico",
        password: "password-sintetica",
        expectedTaxId: "00000000000",
        now: NOW,
      }),
      (error) => error instanceof AppError && error.code === "AUTH_PROVIDER_EXPIRED",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
