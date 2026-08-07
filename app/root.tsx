import { Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";

import favicon from "../docs/brand/assets/favicon.svg?url";
import "./styles.css";

const themeBootstrap = `try{const t=localStorage.getItem("hf-theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch{}`;

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
