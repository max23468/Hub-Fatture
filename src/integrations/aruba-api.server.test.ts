import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { AppError } from "../errors.ts";
import {
  ARUBA_API_V2_CONTRACT,
  arubaApiInvoiceDetailSchema,
  arubaApiNotificationListSchema,
  arubaApiGroupsToShadowDocuments,
  readArubaApiInvoiceDetail,
  readArubaApiInvoicePage,
  readArubaApiNotifications,
  runArubaApiReadProbe,
} from "./aruba-api.server.ts";

const NOW = new Date("2026-08-26T12:00:00.000Z");
const SYNTHETIC_INVOICE_PAGE = JSON.parse(
  readFileSync(
    new URL("../../tests/fixtures/aruba/api-invoices-out.synthetic.json", import.meta.url),
    "utf8",
  ),
) as Record<string, unknown>;

function response(value: unknown): Response {
  return Response.json(value);
}

function invoicePage(input: {
  page: number;
  totalElements: number;
  ids?: string[];
  groups?: Array<Record<string, unknown>>;
}): Record<string, unknown> {
  const ids = input.ids ?? [];
  const groups =
    input.groups ??
    ids.map((id) => ({
      id,
      invoices: [
        {
          invoiceDate: "2026-08-26T12:00:00.000Z",
          number: `FPR-${id}`,
          documentType: "TD01",
          status: "Inviata",
          statusDescription: "",
        },
      ],
      invoiceType: "FPR12",
      docType: "out",
      filename: `IT00000000000_${id}.xml.p7m`,
      idSdi: `SDI-${id}`,
      pddAvailable: true,
      file: null,
    }));
  const totalPages = Math.ceil(input.totalElements / 10);
  return {
    content: groups,
    first: input.page === 1,
    last: totalPages === 0 || input.page === totalPages,
    number: input.page,
    numberOfElements: groups.length,
    size: 10,
    totalElements: input.totalElements,
    totalPages,
  };
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
      return response(invoicePage({ page: 1, totalElements: 0 }));
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
        returnedDocuments: 0,
        totalInvoiceGroups: 0,
        groupCardinality: { empty: 0, single: 0, multiple: 0 },
        documentTypes: { TD01: 0, TD04: 0, other: 0 },
        canonicalStatuses: {
          SUBMITTED: 0,
          SDI_PROCESSING: 0,
          DELIVERED: 0,
          NOT_DELIVERED: 0,
          REJECTED: 0,
          UNKNOWN: 0,
        },
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
      return response(invoicePage({ page: 1, totalElements: 0 }));
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
      return response(
        invoicePage({
          page: Number(page),
          totalElements: 13,
          ids: Array.from({ length: count }, (_, index) => `${page}-${index}`),
        }),
      );
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
    assert.equal(result.returnedDocuments, 13);
    assert.equal(result.totalInvoiceGroups, 13);
    assert.deepEqual(result.groupCardinality, { empty: 0, single: 13, multiple: 0 });
    assert.deepEqual(result.documentTypes, { TD01: 13, TD04: 0, other: 0 });
    assert.equal(result.canonicalStatuses.SUBMITTED, 13);
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
      const page = Number(url.searchParams.get("page"));
      return response(
        invoicePage({
          page,
          totalElements: 31,
          ids: Array.from({ length: 10 }, (_, index) => `${page}-${index}`),
        }),
      );
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
        content: [{ id: "gruppo-1" }],
        first: true,
        last: true,
        number: 1,
        numberOfElements: 2,
        size: 10,
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

test("il probe rifiuta metadati di paginazione coercibili ma non numerici", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const invalidValue of [null, "", false, "0"]) {
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
          ...invoicePage({ page: 1, totalElements: 0 }),
          totalElements: invalidValue,
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
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("il probe rifiuta una pagina diversa da quella richiesta", async () => {
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
      const firstPageIds = Array.from({ length: 10 }, (_, index) => `gruppo-${index}`);
      return response(invoicePage({ page: 1, totalElements: 20, ids: firstPageIds }));
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

test("il probe rifiuta identificativi di gruppo duplicati tra pagine", async () => {
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
      const page = Number(url.searchParams.get("page"));
      return response(
        invoicePage({
          page,
          totalElements: 11,
          ids:
            page === 1 ? Array.from({ length: 10 }, (_, index) => `gruppo-${index}`) : ["gruppo-0"],
        }),
      );
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

test("il probe distingue gruppi vuoti, singoli e multipli senza confonderli con i documenti", async () => {
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
      return response(SYNTHETIC_INVOICE_PAGE);
    };

    const result = await runArubaApiReadProbe({
      environment: "PRODUCTION",
      username: "utente-sintetico",
      password: "password-sintetica",
      expectedTaxId: "00000000000",
      now: NOW,
    });
    assert.equal(result.returnedInvoiceGroups, 3);
    assert.equal(result.returnedDocuments, 3);
    assert.deepEqual(result.groupCardinality, { empty: 1, single: 1, multiple: 1 });
    assert.deepEqual(result.documentTypes, { TD01: 1, TD04: 1, other: 1 });
    assert.equal(result.canonicalStatuses.REJECTED, 1);
    assert.equal(result.canonicalStatuses.DELIVERED, 1);
    assert.equal(result.canonicalStatuses.SDI_PROCESSING, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("l’adapter shadow conserva l’ID del gruppo senza inventare la serie fiscale", () => {
  const groups = (SYNTHETIC_INVOICE_PAGE.content ?? []) as unknown[];
  assert.deepEqual(arubaApiGroupsToShadowDocuments(groups), [
    {
      remoteId: "gruppo-td04-sintetico",
      documentType: "TD04",
      fiscalYear: 2026,
      series: null,
      fiscalNumber: null,
      documentDate: "2026-08-26",
      status: "REJECTED",
    },
    {
      remoteId: "gruppo-multiplo-sintetico",
      documentType: "TD01",
      fiscalYear: 2026,
      series: null,
      fiscalNumber: null,
      documentDate: "2026-08-26",
      status: "DELIVERED",
    },
  ]);
});

test("il contratto rifiuta stati fattura API non documentati", async () => {
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
      const page = invoicePage({ page: 1, totalElements: 1, ids: ["gruppo-1"] });
      (
        (page.content as Array<Record<string, unknown>>)[0]!.invoices as Array<
          Record<string, unknown>
        >
      )[0]!.status = "Emessa";
      return response(page);
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

test("il contratto notifiche verifica cardinalità e risultato", () => {
  const notification = {
    date: "2026-08-26T12:00:00.000Z",
    docType: "RC",
    file: "PHJpY2V2dXRhIC8+",
    filename: "IT00000000000_SYNTH_RC_001.xml",
    invoiceId: "fattura-sintetica",
    notificationDate: "2026-08-26T12:00:00.000Z",
    number: null,
    result: null,
  };
  assert.equal(
    arubaApiNotificationListSchema.parse({ count: 1, notifications: [notification] }).count,
    1,
  );
  assert.equal(
    arubaApiNotificationListSchema.safeParse({ count: 2, notifications: [notification] }).success,
    false,
  );
  assert.equal(
    arubaApiNotificationListSchema.safeParse({
      count: 1,
      notifications: [{ ...notification, result: "EC03" }],
    }).success,
    false,
  );
  assert.equal(
    arubaApiNotificationListSchema.safeParse({
      count: 1,
      notifications: [{ ...notification, file: "non-base64" }],
    }).success,
    false,
  );
});

test("il contratto dettaglio tipizza i file ufficiali senza invocare il provider", () => {
  const detail = {
    channelGroup: 2,
    shopName: null,
    invoices: [
      {
        invoiceDate: "2026-08-26T12:00:00.000Z",
        number: "1",
        documentType: "TD01",
        status: "Consegnata",
        statusDescription: "",
        totalDocument: 100,
        totalVat: 0,
        netPayable: 100,
      },
    ],
    sdiErrors: [],
    id: "invoice-sintetica",
    sender: {
      description: "Cedente sintetico",
      countryCode: "IT",
      vatCode: "00000000000",
      fiscalCode: null,
    },
    receiver: {
      description: "Destinatario sintetico",
      countryCode: "IT",
      vatCode: null,
      fiscalCode: "00000000000",
    },
    invoiceType: "FPR12",
    docType: "out",
    file: "PHhtbC8+",
    filename: "IT00000000000_SYNTH.xml.p7m",
    username: "utente-sintetico",
    creationDate: "2026-08-26T12:00:00.000+0000",
    lastUpdate: "2026-08-26T12:01:00.000Z",
    idSdi: "SDI-SYNTH",
    pdfFile: "JVBERi0xLjQ=",
    pddAvailable: true,
  };
  assert.equal(arubaApiInvoiceDetailSchema.parse(detail).docType, "out");
  assert.equal(
    arubaApiInvoiceDetailSchema.safeParse({ ...detail, file: "non-base64" }).success,
    false,
  );
  assert.equal(arubaApiInvoiceDetailSchema.safeParse({ ...detail, file: "a" }).success, false);
  assert.equal(arubaApiInvoiceDetailSchema.safeParse({ ...detail, docType: "in" }).success, false);
  assert.equal(
    arubaApiInvoiceDetailSchema.safeParse({
      ...detail,
      invoices: [{ ...detail.invoices[0], invoiceDate: "26/08/2026" }],
    }).success,
    false,
  );
});

test("il contratto registra i limiti read-only ufficiali correnti", () => {
  assert.equal(ARUBA_API_V2_CONTRACT.authenticationRequestsPerMinutePerIp, 1);
  assert.equal(ARUBA_API_V2_CONTRACT.sentInvoiceSearchRequestsPerMinutePerIp, 12);
  assert.equal(ARUBA_API_V2_CONTRACT.sentNotificationSearchRequestsPerMinutePerIp, 12);
  assert.equal(ARUBA_API_V2_CONTRACT.maximumSearchWindowHours, 48);
  assert.deepEqual(ARUBA_API_V2_CONTRACT.officialFiles.notifications, ["SDI_NOTIFICATION"]);
});

test("l’adapter inbound usa gli endpoint ufficiali per pagina, dettaglio e notifiche", async () => {
  const originalFetch = globalThis.fetch;
  const paths: string[] = [];
  const group = (
    invoicePage({ page: 1, totalElements: 1, ids: ["gruppo-1"] }).content as unknown[]
  )[0];
  try {
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      paths.push(`${url.pathname}?${url.searchParams.toString()}`);
      if (url.pathname.endsWith("/detail")) {
        return response({
          channelGroup: 1,
          shopName: null,
          invoices: [
            {
              invoiceDate: "2026-08-26T12:00:00.000Z",
              number: "FPR-gruppo-1",
              documentType: "TD01",
              status: "Inviata",
              statusDescription: "",
              totalDocument: "100.00",
              totalVat: "0.00",
              netPayable: "100.00",
            },
          ],
          sdiErrors: [],
          id: "gruppo-1",
          sender: {
            description: "Cedente sintetico",
            countryCode: "IT",
            vatCode: "00000000000",
            fiscalCode: null,
          },
          receiver: {
            description: "Destinatario sintetico",
            countryCode: "IT",
            vatCode: "00000000000",
            fiscalCode: null,
          },
          invoiceType: "FPR12",
          docType: "out",
          file: "PHhtbC8+",
          filename: "IT00000000000_gruppo-1.xml",
          username: "utente-sintetico",
          creationDate: "2026-08-26T12:00:00.000Z",
          lastUpdate: "2026-08-26T12:01:00.000Z",
          idSdi: "SDI-1",
          pdfFile: "JVBERi0xLjQ=",
          pddAvailable: true,
        });
      }
      if (url.pathname.endsWith("/notifications")) {
        return response({ count: 0, notifications: [] });
      }
      return response(invoicePage({ page: 1, totalElements: 1, groups: [group as never] }));
    };
    const session = {
      environment: "PRODUCTION" as const,
      accessToken: "token-sintetico",
      expiresAt: Date.now() + 1_800_000,
    };
    assert.equal(
      (
        await readArubaApiInvoicePage({
          session,
          page: 1,
          windowStart: new Date("2026-08-25T12:00:00.000Z"),
          windowEnd: NOW,
        })
      ).groups.length,
      1,
    );
    assert.equal((await readArubaApiInvoiceDetail(session, "gruppo-1")).id, "gruppo-1");
    assert.equal((await readArubaApiNotifications(session, "gruppo-1")).count, 0);
    assert.match(paths[0]!, /^\/api\/v2\/invoices-out\?/);
    assert.match(paths[1]!, /^\/api\/v2\/invoices-out\/detail\?/);
    assert.match(paths[1]!, /includePdf=true/);
    assert.match(paths[1]!, /includeFile=true/);
    assert.match(paths[2]!, /^\/api\/v2\/invoices-out\/notifications\?/);
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
