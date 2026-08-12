import {
  ClipboardList,
  FileText,
  LayoutDashboard,
  LogOut,
  Settings,
  ShieldCheck,
  ShoppingBag,
  UserRound,
} from "lucide-react";
import { Form, NavLink } from "react-router";

import { copy } from "../copy.it";
import { BrandLockup } from "./brand-lockup";
import { GlobalSearch } from "./global-search";
import { ThemePicker } from "./theme-picker";

const links = [
  { to: "/", label: copy.navigation.dashboard, icon: LayoutDashboard, end: true },
  { to: "/ordini", label: copy.navigation.orders, icon: ShoppingBag, end: false },
  { to: "/documenti", label: copy.navigation.documents, icon: FileText, end: false },
  { to: "/attivita", label: copy.navigation.activity, icon: ClipboardList, end: false },
  { to: "/impostazioni", label: copy.navigation.settings, icon: Settings, end: false },
];

export function AppShell({
  children,
  username,
  canApprove,
  csrfToken,
}: {
  children: React.ReactNode;
  username: string;
  canApprove: boolean;
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
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
      </aside>
      <main className="app-main" id="contenuto-principale">
        <header className="page-header">
          <div />
          <div className="page-header__actions">
            <GlobalSearch />
            <details className="profile-menu">
              <summary aria-label={copy.navigation.openProfile(username)}>
                <UserRound aria-hidden="true" size={20} strokeWidth={1.8} />
                <span className="profile-menu__label">{username}</span>
              </summary>
              <div className="profile-menu__panel">
                <div className="profile-menu__identity">
                  <span className="profile-menu__avatar" aria-hidden="true">
                    <UserRound size={20} strokeWidth={1.8} />
                  </span>
                  <span>
                    <strong>{username}</strong>
                    <small>
                      {canApprove ? copy.navigation.ownerRole : copy.navigation.operatorRole}
                    </small>
                  </span>
                </div>
                <p className="profile-menu__permission">
                  <ShieldCheck aria-hidden="true" size={17} strokeWidth={1.8} />
                  {canApprove
                    ? copy.navigation.ownerPermission
                    : copy.navigation.operatorPermission}
                </p>
                <ThemePicker />
                <a
                  className="button button--secondary button--full"
                  href="/impostazioni#profilo-sicurezza"
                >
                  <Settings aria-hidden="true" size={17} strokeWidth={1.8} />
                  {copy.navigation.profileSettings}
                </a>
                <Form method="post" action="/logout">
                  <input type="hidden" name="csrf" value={csrfToken} />
                  <button className="button button--secondary button--full" type="submit">
                    <LogOut aria-hidden="true" size={17} strokeWidth={1.8} />
                    {copy.navigation.logout}
                  </button>
                </Form>
              </div>
            </details>
          </div>
        </header>
        {children}
      </main>
    </div>
  );
}
