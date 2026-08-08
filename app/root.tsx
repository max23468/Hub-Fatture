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

const themeBootstrap = `try{const t=localStorage.getItem("tema");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch{}`;

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="it" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <link rel="icon" href={favicon} type="image/svg+xml" />
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
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
        <p className="eyebrow">Errore</p>
        <h1 id="error-title">{notFound ? copy.errorNotFound : copy.errorUnexpected}</h1>
        <p>{copy.errorAction}</p>
        <a className="button" href="/">
          {copy.errorHome}
        </a>
      </section>
    </main>
  );
}
