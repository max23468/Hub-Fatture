import {
  ClipboardList,
  FileText,
  LayoutDashboard,
  LogOut,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  ShieldCheck,
  ShoppingBag,
  UserRound,
  UsersRound,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Form, NavLink, useLocation } from "react-router";

import { copy } from "../copy.it";
import { BrandLockup } from "./brand-lockup";
import { GlobalSearch } from "./global-search";
import { ThemePicker } from "./theme-picker";

const links = [
  { to: "/", label: copy.navigation.dashboard, icon: LayoutDashboard, end: true },
  { to: "/ordini", label: copy.navigation.orders, icon: ShoppingBag, end: false },
  { to: "/documenti", label: copy.navigation.documents, icon: FileText, end: false },
  { to: "/clienti", label: copy.navigation.customers, icon: UsersRound, end: false },
  {
    to: "/attivita",
    label: copy.navigation.activity,
    icon: ClipboardList,
    end: false,
  },
  {
    to: "/impostazioni",
    label: copy.navigation.settings,
    icon: Settings,
    end: false,
  },
];

function NavigationLinks({ onNavigate }: { onNavigate?: () => void }) {
  return links.map(({ to, label, icon: Icon, end }) => (
    <NavLink
      aria-label={label}
      className="nav-item"
      data-tooltip={label}
      end={end}
      key={to}
      onClick={onNavigate}
      to={to}
    >
      <Icon aria-hidden="true" size={20} strokeWidth={1.8} />
      <span className="nav-item__label">{label}</span>
    </NavLink>
  ));
}

const sidebarChangeEvent = "hub-fatture:sidebar-change";

function subscribeToSidebar(callback: () => void) {
  window.addEventListener(sidebarChangeEvent, callback);
  return () => window.removeEventListener(sidebarChangeEvent, callback);
}

function getSidebarCollapsed() {
  return document.documentElement.dataset.sidebar === "collapsed";
}

const subscribeToHydration = () => () => {};

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
  const location = useLocation();
  const mobileNavigation = useRef<HTMLDialogElement>(null);
  const mobileNavigationTrigger = useRef<HTMLButtonElement>(null);
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const sidebarCollapsed = useSyncExternalStore(
    subscribeToSidebar,
    getSidebarCollapsed,
    () => false,
  );

  function toggleSidebar() {
    const nextCollapsed = !sidebarCollapsed;
    document.documentElement.dataset.sidebar = nextCollapsed ? "collapsed" : "expanded";
    try {
      localStorage.setItem("sidebar", nextCollapsed ? "collapsed" : "expanded");
    } catch {
      // La preferenza resta valida per la sessione anche se lo storage non è disponibile.
    }
    window.dispatchEvent(new Event(sidebarChangeEvent));
  }

  const sidebarAction = sidebarCollapsed
    ? copy.navigation.expandSidebar
    : copy.navigation.collapseSidebar;
  const SidebarActionIcon = sidebarCollapsed ? PanelLeftOpen : PanelLeftClose;

  const profileReady = useSyncExternalStore(
    subscribeToHydration,
    () => true,
    () => false,
  );

  function openMobileNavigation() {
    mobileNavigation.current?.showModal();
    setMobileNavigationOpen(true);
  }

  function closeMobileNavigation() {
    mobileNavigation.current?.close();
    setMobileNavigationOpen(false);
  }

  useEffect(() => {
    if (mobileNavigation.current?.open) mobileNavigation.current.close();
    setMobileNavigationOpen(false);
  }, [location.pathname, location.search]);

  return (
    <div className="app-layout">
      <a className="skip-link" href="#contenuto-principale">
        {copy.navigation.skipToContent}
      </a>
      <aside className="sidebar">
        <BrandLockup onDark />
        <nav aria-label={copy.navigation.mainLabel} id="navigazione-principale">
          <NavigationLinks />
        </nav>
        <button
          aria-controls="navigazione-principale"
          aria-expanded={!sidebarCollapsed}
          aria-label={sidebarAction}
          className="sidebar-toggle"
          data-tooltip={sidebarAction}
          onClick={toggleSidebar}
          type="button"
        >
          <SidebarActionIcon aria-hidden="true" size={20} strokeWidth={1.8} />
          <span className="sidebar-toggle__label">{sidebarAction}</span>
        </button>
      </aside>
      <dialog
        aria-label={copy.navigation.mainLabel}
        className="mobile-navigation"
        id="navigazione-mobile"
        onClose={() => {
          setMobileNavigationOpen(false);
          const focusDelay = window.matchMedia("(prefers-reduced-motion: no-preference)").matches
            ? 200
            : 0;
          window.setTimeout(() => mobileNavigationTrigger.current?.focus(), focusDelay);
        }}
        ref={mobileNavigation}
      >
        <div className="mobile-navigation__header">
          <BrandLockup onDark />
          <button
            aria-label={copy.navigation.closeMenu}
            className="mobile-navigation__close"
            onClick={closeMobileNavigation}
            type="button"
          >
            <X aria-hidden="true" size={22} strokeWidth={1.8} />
          </button>
        </div>
        <nav aria-label={copy.navigation.mainLabel}>
          <NavigationLinks onNavigate={closeMobileNavigation} />
        </nav>
      </dialog>
      <main className="app-main" id="contenuto-principale">
        <header className="page-header">
          <button
            aria-controls="navigazione-mobile"
            aria-expanded={mobileNavigationOpen}
            aria-label={copy.navigation.openMenu}
            className="mobile-navigation-toggle"
            onClick={openMobileNavigation}
            ref={mobileNavigationTrigger}
            type="button"
          >
            <Menu aria-hidden="true" size={22} strokeWidth={1.8} />
          </button>
          <div className="page-header__actions">
            <GlobalSearch />
            <details className="profile-menu" inert={!profileReady}>
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
