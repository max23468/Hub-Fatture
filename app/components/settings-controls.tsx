import {
  ChevronDown,
  CircleUserRound,
  FileCheck2,
  Landmark,
  Mail,
  PlugZap,
  Settings2,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import {
  useEffect,
  useState,
  type FormEvent,
  type ReactNode,
  type SelectHTMLAttributes,
} from "react";
import { Form } from "react-router";

import { copy } from "../copy.it";

const sections: Array<{ id: string; label: string; icon: LucideIcon }> = [
  { id: "profilo-sicurezza", label: copy.settings.profileTitle, icon: CircleUserRound },
  { id: "fatturazione", label: copy.settings.billingTitle, icon: Settings2 },
  { id: "profilo-fiscale", label: copy.settings.fiscalTitle, icon: FileCheck2 },
  { id: "connessioni", label: copy.settings.connectionsTitle, icon: PlugZap },
  { id: "aruba-helper", label: copy.settings.arubaTitle, icon: Landmark },
  { id: "email-cliente", label: copy.settings.customerEmailTitle, icon: Mail },
  { id: "sistema", label: copy.settings.systemTitle, icon: ShieldCheck },
];

export function SettingsNavigation() {
  const [active, setActive] = useState(sections[0]!.id);

  useEffect(() => {
    const updateActive = () => {
      const threshold = window.innerHeight * 0.25;
      const current = sections.reduce((selected, section) => {
        const element = document.getElementById(section.id);
        return element && element.getBoundingClientRect().top <= threshold ? section.id : selected;
      }, sections[0]!.id);
      setActive(current);
    };
    updateActive();
    window.addEventListener("scroll", updateActive, { passive: true });
    window.addEventListener("resize", updateActive);
    return () => {
      window.removeEventListener("scroll", updateActive);
      window.removeEventListener("resize", updateActive);
    };
  }, []);

  const selectSection = (id: string) => {
    setActive(id);
    window.history.replaceState(null, "", `#${id}`);
    document.getElementById(id)?.scrollIntoView();
  };

  return (
    <aside className="settings-navigation">
      <label className="settings-section-picker">
        {copy.settings.goToSection}
        <SettingsSelect
          value={active}
          onChange={(event) => selectSection(event.currentTarget.value)}
        >
          {sections.map(({ id, label }) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </SettingsSelect>
      </label>
      <nav className="settings-nav" aria-label={copy.settings.sectionsLabel}>
        {sections.map(({ id, label, icon: Icon }) => (
          <a
            aria-current={active === id ? "location" : undefined}
            className="settings-nav__item"
            href={`#${id}`}
            key={id}
            onClick={() => setActive(id)}
          >
            <Icon aria-hidden="true" size={18} strokeWidth={1.8} />
            {label}
          </a>
        ))}
      </nav>
    </aside>
  );
}

export function SettingsSelect({
  children,
  className,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className={`settings-select${className ? ` ${className}` : ""}`}>
      <select {...props}>{children}</select>
      <ChevronDown aria-hidden="true" size={18} strokeWidth={2} />
    </span>
  );
}

export function SettingsForm({
  accessibleSubmitLabel,
  children,
  className,
  submitLabel,
}: {
  accessibleSubmitLabel?: string;
  children: ReactNode;
  className: string;
  submitLabel: string;
}) {
  const [dirty, setDirty] = useState(false);
  const updateDirty = (event: FormEvent<HTMLFormElement>) => {
    setDirty(
      Array.from(event.currentTarget.elements).some(
        (element) =>
          element instanceof HTMLSelectElement &&
          element.dataset.initial !== undefined &&
          element.value !== element.dataset.initial,
      ),
    );
  };

  return (
    <Form method="post" className={className} onChange={updateDirty}>
      {children}
      <button aria-label={accessibleSubmitLabel} className="button" disabled={!dirty} type="submit">
        {submitLabel}
      </button>
    </Form>
  );
}

export function SettingsSectionHeader({
  id,
  icon: Icon,
  title,
  intro,
}: {
  id: string;
  icon: LucideIcon;
  title: string;
  intro: string;
}) {
  return (
    <header className="settings-section__header">
      <span className="settings-section__icon" aria-hidden="true">
        <Icon size={20} strokeWidth={1.8} />
      </span>
      <div className="settings-section__heading">
        <h2 id={id + "-title"}>{title}</h2>
        <p>{intro}</p>
      </div>
    </header>
  );
}
