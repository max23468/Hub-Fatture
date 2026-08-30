import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { PRIVATE_ROBOTS_DIRECTIVE, privatePageKeys, privatePageMeta } from "./metadata.ts";
import { WEB_MANIFEST_PATH, privateWebManifest } from "./web-manifest.ts";

function titleFrom(meta: ReturnType<typeof privatePageMeta>) {
  const descriptor = meta.find((candidate) => "title" in candidate);
  return descriptor && "title" in descriptor && typeof descriptor.title === "string"
    ? descriptor.title
    : undefined;
}

function contentByName(meta: ReturnType<typeof privatePageMeta>, name: string) {
  const descriptor = meta.find((candidate) => "name" in candidate && candidate.name === name);
  return descriptor && "content" in descriptor && typeof descriptor.content === "string"
    ? descriptor.content
    : undefined;
}

function contentByProperty(meta: ReturnType<typeof privatePageMeta>, property: string) {
  const descriptor = meta.find(
    (candidate) => "property" in candidate && candidate.property === property,
  );
  return descriptor && "content" in descriptor && typeof descriptor.content === "string"
    ? descriptor.content
    : undefined;
}

test("ogni pagina privata espone metadati completi e non indicizzabili", () => {
  assert.equal(privatePageKeys.length, 16);
  for (const page of privatePageKeys) {
    const meta = privatePageMeta(page);
    const title = titleFrom(meta);
    const description = contentByName(meta, "description");

    if (!title) assert.fail(`titolo assente per ${page}`);
    if (!description) assert.fail(`descrizione assente per ${page}`);
    assert.ok(title.length <= 60, `titolo troppo lungo per ${page}`);
    assert.ok(description.length <= 160, `descrizione troppo lunga per ${page}`);
    assert.equal(contentByName(meta, "robots"), PRIVATE_ROBOTS_DIRECTIVE);
    assert.equal(contentByName(meta, "googlebot"), PRIVATE_ROBOTS_DIRECTIVE);
    assert.equal(contentByName(meta, "referrer"), "same-origin");
    assert.equal(contentByName(meta, "application-name"), "Hub Fatture");
    assert.equal(contentByProperty(meta, "og:title"), title);
    assert.equal(contentByProperty(meta, "og:description"), description);
    assert.equal(contentByName(meta, "twitter:title"), title);
    assert.equal(contentByName(meta, "twitter:description"), description);
    assert.equal(
      meta.filter((descriptor) => "name" in descriptor && descriptor.name === "theme-color").length,
      2,
    );
    assert.equal(
      meta.some((descriptor) => "script:ld+json" in descriptor),
      false,
    );
    assert.equal(
      meta.some(
        (descriptor) =>
          "tagName" in descriptor &&
          descriptor.tagName === "link" &&
          descriptor.rel === "canonical",
      ),
      false,
    );
  }
});

test("un dettaglio aggiunge l’identificativo operativo senza perdere i metadati condivisi", () => {
  const meta = privatePageMeta("order", { title: "Ordine Shopify 1001" });

  assert.equal(titleFrom(meta), "Ordine Shopify 1001 · Hub Fatture");
  assert.equal(contentByProperty(meta, "og:title"), "Ordine Shopify 1001 · Hub Fatture");
  assert.equal(contentByName(meta, "robots"), PRIVATE_ROBOTS_DIRECTIVE);
});

test("ogni route visuale dichiara i metadati della pagina", async () => {
  const routeConfig = await readFile(new URL("./routes.ts", import.meta.url), "utf8");
  const routeModules = [...routeConfig.matchAll(/"(routes\/[^"]+\.tsx)"/g)].map(
    ([, modulePath]) => modulePath,
  );

  assert.ok(routeModules.length > 0);
  for (const modulePath of routeModules) {
    const source = await readFile(new URL(`./${modulePath}`, import.meta.url), "utf8");
    assert.match(source, /export function meta|export const meta/, `meta assente in ${modulePath}`);
  }
});

test("il manifest usa identità e icone canoniche senza rendere pubblica l'app", () => {
  const manifest = privateWebManifest({
    faviconHref: "/assets/favicon.svg",
    appIconHref: "/assets/app-icon.png",
  });

  assert.equal(WEB_MANIFEST_PATH, "/manifest.webmanifest");
  assert.equal(manifest.id, "/");
  assert.equal(manifest.name, "Hub Fatture");
  assert.equal(manifest.short_name, "Hub Fatture");
  assert.equal(manifest.lang, "it");
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.scope, "/");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.background_color, "#f4f8fa");
  assert.equal(manifest.theme_color, "#064b63");
  assert.deepEqual(manifest.icons, [
    {
      src: "/assets/favicon.svg",
      sizes: "any",
      type: "image/svg+xml",
      purpose: "any",
    },
    {
      src: "/assets/app-icon.png",
      sizes: "1200x1200",
      type: "image/png",
      purpose: "any",
    },
  ]);
});

test("la shell browser espone manifest, fallback icone e integrazione mobile", async () => {
  const [root, routes, manifestRoute, caddy] = await Promise.all(
    ["root.tsx", "routes.ts", "routes/manifest.ts", "../ops/Caddyfile.production"].map((file) =>
      readFile(new URL(`./${file}`, import.meta.url), "utf8"),
    ),
  );

  assert.match(routes, /route\("manifest\.webmanifest", "routes\/manifest\.ts"\)/);
  assert.match(root, /rel="manifest"/);
  assert.match(root, /type="image\/svg\+xml" sizes="any"/);
  assert.match(root, /type="image\/png" sizes="1200x1200"/);
  assert.match(root, /rel="apple-touch-icon"/);
  assert.match(root, /rel="mask-icon"/);
  assert.match(root, /name="mobile-web-app-capable" content="yes"/);
  assert.match(root, /name="apple-mobile-web-app-capable" content="yes"/);
  assert.match(root, /name="color-scheme" content="light dark"/);
  assert.match(manifestRoute, /application\/manifest\+json/);
  assert.match(manifestRoute, /X-Robots-Tag/);
  assert.ok(caddy.includes(`X-Robots-Tag "${PRIVATE_ROBOTS_DIRECTIVE}"`));
});
