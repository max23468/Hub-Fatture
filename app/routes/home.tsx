import { Form, redirect, useLoaderData } from "react-router";
import { LayoutDashboard, LogOut, UserRound } from "lucide-react";
import type { Route } from "./+types/home";

import { BrandLockup } from "../components/brand-lockup";
import { ThemePicker } from "../components/theme-picker";
import { copy } from "../copy.it";
import { getSessionUser } from "../../src/auth.server.ts";

export async function loader({ request }: Route.LoaderArgs) {
  const user = await getSessionUser(request);
  if (!user) throw redirect("/login");
  return { username: user.username, csrfToken: user.csrfToken };
}

export function meta(_: Route.MetaArgs) {
  return [
    { title: "Hub Fatture" },
    { name: "description", content: "Gestione privata del flusso di fatturazione" },
  ];
}

export default function Home() {
  const { username, csrfToken } = useLoaderData<typeof loader>();
  return (
    <div className="app-layout">
      <aside className="sidebar">
        <BrandLockup onDark />
        <nav aria-label="Navigazione principale">
          <a aria-current="page" className="nav-item" href="/">
            <LayoutDashboard aria-hidden="true" size={20} strokeWidth={1.8} />
            {copy.dashboardTitle}
          </a>
        </nav>
      </aside>
      <main className="app-main">
        <header className="page-header">
          <div>
            <h1>{copy.dashboardTitle}</h1>
          </div>
          <details className="profile-menu">
            <summary aria-label="Apri il menu del profilo">
              <UserRound aria-hidden="true" size={20} strokeWidth={1.8} />
              <span className="profile-menu__label">Profilo</span>
            </summary>
            <div className="profile-menu__panel">
              <p className="profile-menu__identity">{username}</p>
              <ThemePicker />
              <Form method="post" action="/logout">
                <input type="hidden" name="csrf" value={csrfToken} />
                <button className="button button--secondary button--full" type="submit">
                  <LogOut aria-hidden="true" size={17} strokeWidth={1.8} />
                  {copy.logout}
                </button>
              </Form>
            </div>
          </details>
        </header>
        <section className="empty-state" aria-labelledby="empty-state-title">
          <p className="eyebrow">Ambiente locale</p>
          <h2 id="empty-state-title">Nessun dato disponibile</h2>
          <p>{copy.safeEmptyState}</p>
        </section>
      </main>
    </div>
  );
}
