import {
  ClipboardList,
  LayoutDashboard,
  LogOut,
  Settings,
  ShoppingBag,
  UserRound,
} from "lucide-react";
import { Form, NavLink } from "react-router";

import { copy } from "../copy.it";
import { BrandLockup } from "./brand-lockup";
import { ThemePicker } from "./theme-picker";

const links = [
  { to: "/", label: copy.navigation.dashboard, icon: LayoutDashboard, end: true },
  { to: "/ordini", label: copy.navigation.orders, icon: ShoppingBag, end: false },
  { to: "/attivita", label: copy.navigation.activity, icon: ClipboardList, end: false },
  { to: "/impostazioni", label: copy.navigation.settings, icon: Settings, end: false },
];

export function AppShell({
  children,
  username,
  csrfToken,
}: {
  children: React.ReactNode;
  username: string;
  csrfToken: string;
}) {
  return (
    <div className="app-layout">
      <a className="skip-link" href="#contenuto-principale">
        {copy.navigation.skipToContent}
      </a>
      <aside className="sidebar">
        <BrandLockup onDark />
        <nav aria-label={copy.navigation.mainLabel}>
          {links.map(({ to, label, icon: Icon, end }) => (
            <NavLink className="nav-item" end={end} key={to} to={to}>
              <Icon aria-hidden="true" size={20} strokeWidth={1.8} />
              {label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <main className="app-main" id="contenuto-principale">
        <header className="page-header">
          <div />
          <details className="profile-menu">
            <summary aria-label={copy.navigation.openProfile(username)}>
              <UserRound aria-hidden="true" size={20} strokeWidth={1.8} />
              <span className="profile-menu__label">{username}</span>
            </summary>
            <div className="profile-menu__panel">
              <p className="profile-menu__identity">{username}</p>
              <ThemePicker />
              <Form method="post" action="/logout">
                <input type="hidden" name="csrf" value={csrfToken} />
                <button className="button button--secondary button--full" type="submit">
                  <LogOut aria-hidden="true" size={17} strokeWidth={1.8} />
                  {copy.navigation.logout}
                </button>
              </Form>
            </div>
          </details>
        </header>
        {children}
      </main>
    </div>
  );
}
