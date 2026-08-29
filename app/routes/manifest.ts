import appIcon from "../../docs/brand/assets/shopify-app-icon.png?url";
import favicon from "../../docs/brand/assets/favicon.svg?url";
import { securePrivateHeaders } from "../../src/http.server.ts";
import { PRIVATE_ROBOTS_DIRECTIVE } from "../metadata.ts";
import { privateWebManifest } from "../web-manifest.ts";

export function loader() {
  const headers = new Headers({
    "Content-Language": "it",
    "Content-Type": "application/manifest+json; charset=utf-8",
    "X-Robots-Tag": PRIVATE_ROBOTS_DIRECTIVE,
  });
  securePrivateHeaders(headers);

  const manifest = privateWebManifest({
    faviconHref: favicon,
    appIconHref: appIcon,
  });
  return new Response(JSON.stringify(manifest), { headers });
}
