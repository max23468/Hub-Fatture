import { PassThrough } from "node:stream";

import { createReadableStreamFromReadable } from "@react-router/node";
import { renderToPipeableStream } from "react-dom/server";
import { ServerRouter } from "react-router";
import type { EntryContext, RouterContextProvider } from "react-router";

import { startRetention } from "../src/db/retention.server.ts";
import { securePrivateHeaders } from "../src/http.server.ts";

startRetention();

export default function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
  _loadContext: RouterContextProvider,
) {
  // ponytail: aggiungere nonce e `script-src` prima del deploy Production o se entra un
  // secondo script inline; fino ad allora queste direttive coprono il perimetro attuale.
  responseHeaders.set("Content-Security-Policy", "frame-ancestors 'none'");
  responseHeaders.set("Referrer-Policy", "same-origin");
  responseHeaders.set("X-Content-Type-Options", "nosniff");
  securePrivateHeaders(responseHeaders);

  if (request.method.toUpperCase() === "HEAD") {
    return new Response(null, {
      headers: responseHeaders,
      status: responseStatusCode,
    });
  }

  return new Promise<Response>((resolve, reject) => {
    let shellRendered = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const { pipe, abort } = renderToPipeableStream(
      <ServerRouter context={routerContext} url={request.url} />,
      {
        onShellReady() {
          shellRendered = true;
          const body = new PassThrough({
            final(callback) {
              clearTimeout(timeoutId);
              callback();
            },
          });
          const stream = createReadableStreamFromReadable(body);
          responseHeaders.set("Content-Type", "text/html");
          resolve(
            new Response(stream, {
              headers: responseHeaders,
              status: responseStatusCode,
            }),
          );
          pipe(body);
        },
        onShellError: reject,
        onError(error) {
          responseStatusCode = 500;
          if (shellRendered) console.error(error);
        },
      },
    );

    timeoutId = setTimeout(abort, 5_000);
  });
}

export function handleDataRequest(response: Response) {
  securePrivateHeaders(response.headers);
  return response;
}
