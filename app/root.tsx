import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useRouteError,
} from "react-router";

import { BrandLockup } from "./components/brand-lockup";
import { copy } from "./copy.it";
import favicon from "../docs/brand/assets/favicon.svg?url";
import "./styles.css";

const uiBootstrap = `try{const t=localStorage.getItem("tema");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t;const s=localStorage.getItem("sidebar");const n=matchMedia("(min-width:48.0625rem) and (max-width:63.999rem)").matches;document.documentElement.dataset.sidebar=s==="collapsed"||(s!=="expanded"&&n)?"collapsed":"expanded"}catch{}`;

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="it" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <link rel="icon" href={favicon} type="image/svg+xml" />
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

export function ErrorBoundary() {
  const error = useRouteError();
  const notFound = isRouteErrorResponse(error) && error.status === 404;
  return (
    <main className="auth-shell">
      <BrandLockup />
      <section className="card" aria-labelledby="error-title">
        <p className="eyebrow">{copy.error.eyebrow}</p>
        <h1 id="error-title">{notFound ? copy.error.notFound : copy.error.unexpected}</h1>
        <p>{copy.error.action}</p>
        <a className="button" href="/">
          {copy.error.home}
        </a>
      </section>
    </main>
  );
}
