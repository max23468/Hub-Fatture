import { useEffect, useRef, useState } from "react";
import { data } from "react-router";
import type { Route } from "./+types/aruba-bridge";

import { copy } from "../copy.it";
import {
  claimArubaBridgeStart,
  sendArubaBridgeReady,
  sendArubaBridgeResponse,
  sendArubaBridgeRuntime,
} from "../aruba-bridge-state.ts";
import { privateRouteMeta } from "../metadata";
import { ARUBA_IMPORT_MAX_BYTES, ARUBA_PANEL_ORIGIN } from "../../src/aruba-browser-constants.ts";
import { buildArubaBookmarkletRuntime } from "../../src/aruba-bookmarklet.ts";
import { getConfig } from "../../src/config.server.ts";
import { requireSessionUser } from "../../src/db/auth.server.ts";

const bridgeType = "HF_ARUBA";

export function meta({ error }: Route.MetaArgs) {
  return privateRouteMeta("settings", {
    error,
    title: copy.settings.arubaBridgeTitle,
    description: copy.settings.arubaBridgeHelp,
  });
}

function panelOrigin() {
  const config = getConfig();
  return config.APP_ENV === "production" ? ARUBA_PANEL_ORIGIN : new URL(config.APP_BASE_URL).origin;
}

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireSessionUser(request);
  const allowedPanelOrigin = panelOrigin();
  return data(
    {
      csrfToken: user.csrfToken,
      panelOrigin: allowedPanelOrigin,
      runtimeSource: buildArubaBookmarkletRuntime({
        hubOrigin: new URL(request.url).origin,
        panelOrigin: allowedPanelOrigin,
      }),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

const allowedRequests = new Map([
  ["GET /api/aruba/sync/manifest", true],
  ["POST /api/aruba/sync/heartbeat", true],
  ["POST /api/aruba/sync/verifica-account", true],
  ["POST /api/aruba/sync/pagine", true],
  ["POST /api/aruba/sync/completa", true],
  ["POST /api/aruba/sync/termina", true],
  ["POST /api/aruba/sync/fallita", true],
  ["GET /api/aruba/sync/preflight", true],
  ["POST /api/aruba/sync/preflight", true],
  ["POST /api/aruba/sync/file", true],
]);

export default function ArubaBridge({ loaderData }: Route.ComponentProps) {
  const { csrfToken, panelOrigin: allowedPanelOrigin, runtimeSource } = loaderData;
  const [status, setStatus] = useState<string>(copy.settings.arubaBridgeWaiting);
  const tokenRef = useRef<string | null>(null);
  const issuingRef = useRef<Promise<string> | null>(null);
  const startedRef = useRef(false);
  const readyRef = useRef(false);

  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- Il fetch non carica dati di rendering: risponde a un messaggio autenticato del pannello esterno durante la vita del ponte.
  useEffect(() => {
    const panel = window.opener;
    if (!panel) {
      setStatus(copy.settings.arubaBridgeMissingPanel);
      return;
    }

    const issueToken = () => {
      if (tokenRef.current) return Promise.resolve(tokenRef.current);
      if (issuingRef.current) return issuingRef.current;
      const form = new FormData();
      form.set("csrf", csrfToken);
      issuingRef.current = fetch("/api/aruba/sync/sessione-browser", {
        method: "POST",
        body: form,
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      })
        .then(async (response) => {
          if (!response.ok) {
            const failure = (await response.json().catch(() => ({}))) as { code?: unknown };
            throw new Error(typeof failure.code === "string" ? failure.code : "HUB_ERROR");
          }
          const payload = (await response.json()) as { token?: unknown };
          if (typeof payload.token !== "string") throw new Error("HUB_ERROR");
          tokenRef.current = payload.token;
          return payload.token;
        })
        .finally(() => {
          issuingRef.current = null;
        });
      return issuingRef.current;
    };

    const respond = (response: unknown) =>
      sendArubaBridgeResponse({
        panel,
        response,
        targetOrigin: allowedPanelOrigin,
      });

    const receiveRequest = async (request: Record<string, unknown>) => {
      const id = String(request.id ?? "");
      const method = String(request.method ?? "GET").toUpperCase();
      const path = String(request.path ?? "");
      if (!/^\d{1,20}$/.test(id) || !allowedRequests.has(`${method} ${path}`)) return;
      try {
        const token = await issueToken();
        const fileRequest = path === "/api/aruba/sync/file";
        const filePayload = request.body as
          | { remoteId?: unknown; kind?: unknown; bytes?: unknown }
          | undefined;
        if (
          fileRequest &&
          (typeof filePayload?.remoteId !== "string" ||
            !filePayload.remoteId ||
            filePayload.remoteId.length > 200 ||
            filePayload.kind !== "ARUBA_XML" ||
            !(filePayload.bytes instanceof ArrayBuffer) ||
            !filePayload.bytes.byteLength ||
            filePayload.bytes.byteLength > ARUBA_IMPORT_MAX_BYTES)
        ) {
          throw new Error("INVALID_FILE_PAYLOAD");
        }
        const jsonBody =
          method === "POST" && !fileRequest ? JSON.stringify(request.body ?? {}) : undefined;
        if (jsonBody && jsonBody.length > 1_000_000) throw new Error("PAYLOAD_TOO_LARGE");
        const targetPath = fileRequest
          ? `/api/aruba/sync/documenti/${encodeURIComponent(filePayload!.remoteId as string)}/file`
          : path;
        const response = await fetch(targetPath, {
          method,
          body: fileRequest ? (filePayload!.bytes as ArrayBuffer) : jsonBody,
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
            ...(fileRequest
              ? {
                  "Content-Type": "application/octet-stream",
                  "X-Aruba-File-Kind": "ARUBA_XML",
                }
              : jsonBody
                ? { "Content-Type": "application/json" }
                : {}),
          },
        });
        if (!response.ok) {
          const failure = (await response.json().catch(() => ({}))) as { code?: unknown };
          respond({
            type: `${bridgeType}_RESPONSE`,
            id,
            ok: false,
            code: typeof failure.code === "string" ? failure.code : `HUB_${response.status}`,
          });
          return;
        }
        const payload = (await response.json()) as unknown;
        respond({
          type: `${bridgeType}_RESPONSE`,
          id,
          ok: true,
          payload,
        });
      } catch (error) {
        respond({
          type: `${bridgeType}_RESPONSE`,
          id,
          ok: false,
          code: error instanceof Error ? error.message : "HUB_ERROR",
        });
      }
    };

    const receive = (event: MessageEvent) => {
      if (event.origin !== allowedPanelOrigin || event.source !== panel) return;
      if (event.data?.type === `${bridgeType}_HELLO`) {
        if (!claimArubaBridgeStart(startedRef)) return;
        try {
          sendArubaBridgeRuntime({
            panel,
            runtimeSource,
            targetOrigin: allowedPanelOrigin,
          });
        } catch {
          startedRef.current = false;
          setStatus(copy.settings.arubaBridgeFailed);
        }
        return;
      }
      if (event.data?.type === `${bridgeType}_RUNTIME_READY` && startedRef.current) {
        try {
          sendArubaBridgeReady({
            panel,
            targetOrigin: allowedPanelOrigin,
          });
          readyRef.current = true;
          setStatus(copy.settings.arubaBridgeActive);
        } catch {
          readyRef.current = false;
          startedRef.current = false;
          setStatus(copy.settings.arubaBridgeFailed);
        }
        return;
      }
      if (
        event.data?.type !== `${bridgeType}_REQUEST` ||
        !readyRef.current ||
        !event.data ||
        typeof event.data !== "object"
      )
        return;
      void receiveRequest(event.data as Record<string, unknown>);
    };

    window.addEventListener("message", receive);
    return () => {
      readyRef.current = false;
      window.removeEventListener("message", receive);
    };
  }, [allowedPanelOrigin, csrfToken, runtimeSource]);

  return (
    <main className="public-page public-page--compact">
      <section className="card public-card public-state" aria-labelledby="aruba-bridge-title">
        <p className="eyebrow">{copy.appName}</p>
        <h1 id="aruba-bridge-title">{copy.settings.arubaBridgeTitle}</h1>
        <p>{copy.settings.arubaBridgeHelp}</p>
        <p className="notice" role="status">
          {status}
        </p>
      </section>
    </main>
  );
}
