import { CircleAlert, FileQuestion } from "lucide-react";
import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useRouteError,
} from "react-router";
import type { MetaFunction } from "react-router";
import type { Route } from "./+types/root";

import { PublicCardHeader, PublicPage } from "./components/public-page";
import { copy } from "./copy.it";
import { privateRouteMeta } from "./metadata";
import { WEB_MANIFEST_PATH } from "./web-manifest";
import favicon from "../docs/brand/assets/favicon.svg?url";
import appIcon from "../docs/brand/assets/shopify-app-icon.png?url";
import maskIcon from "../docs/brand/assets/shopify-navigation-icon.svg?url";
import { getSessionUser } from "../src/db/auth.server.ts";
import { readOperationalControlSummary } from "../src/db/operational-controls.server.ts";
import "./styles.css";
import "./styles/aruba-settings.css";
import "./styles/aruba-document-status.css";
import "./styles/documents.css";
import "./styles/mobile-navigation.css";
import "./styles/preparation.css";

const uiBootstrap = `try{const t=localStorage.getItem("tema");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t;const s=localStorage.getItem("sidebar");const n=matchMedia("(min-width:48.0625rem) and (max-width:63.999rem)").matches;document.documentElement.dataset.sidebar=s==="collapsed"||(s!=="expanded"&&n)?"collapsed":"expanded"}catch{}`;

export async function loader({ request }: Route.LoaderArgs) {
  const user = await getSessionUser(request);
  return {
    navigationControlCount: user ? (await readOperationalControlSummary()).open : 0,
  };
}

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="it" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="light dark" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        <Meta />
        <link rel="manifest" href={WEB_MANIFEST_PATH} />
        <link rel="icon" href={favicon} type="image/svg+xml" sizes="any" />
        <link rel="icon" href={appIcon} type="image/png" sizes="1200x1200" />
        <link rel="apple-touch-icon" href={appIcon} />
        <link rel="mask-icon" href={maskIcon} color="#064b63" />
        <script dangerouslySetInnerHTML={{ __html: uiBootstrap }} />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export const meta: MetaFunction = ({ error }) => {
  return privateRouteMeta("app", { error });
};

export function ErrorBoundary() {
  const error = useRouteError();
  const notFound = isRouteErrorResponse(error) && error.status === 404;
  return (
    <PublicPage compact>
      <section className="card public-card public-state" aria-labelledby="error-title">
        <PublicCardHeader
          description={notFound ? copy.error.notFoundHelp : copy.error.unexpectedHelp}
          eyebrow={copy.error.eyebrow}
          icon={
            notFound ? (
              <FileQuestion size={22} strokeWidth={1.8} />
            ) : (
              <CircleAlert size={22} strokeWidth={1.8} />
            )
          }
          title={notFound ? copy.error.notFound : copy.error.unexpected}
          titleId="error-title"
        />
        <p className="public-state__action">{copy.error.action}</p>
        <a className="button" href="/">
          {copy.error.home}
        </a>
      </section>
    </PublicPage>
  );
}
