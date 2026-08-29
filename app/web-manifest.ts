import { copy } from "./copy.it.ts";

export const WEB_MANIFEST_PATH = "/manifest.webmanifest";

// Integra l'app con i browser senza introdurre segnali di indicizzazione pubblica.
export function privateWebManifest({
  faviconHref,
  appIconHref,
}: {
  faviconHref: string;
  appIconHref: string;
}) {
  return {
    id: "/",
    name: copy.appName,
    short_name: copy.appName,
    description: "Applicazione privata per la gestione della fatturazione elettronica.",
    lang: "it",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#f4f8fa",
    theme_color: "#064b63",
    icons: [
      {
        src: faviconHref,
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
      {
        src: appIconHref,
        sizes: "1200x1200",
        type: "image/png",
        purpose: "any",
      },
    ],
  } as const;
}
