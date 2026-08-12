import {
  CircleUserRound,
  FileCheck2,
  Landmark,
  Mail,
  PlugZap,
  Settings2,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
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
    if (window.location.hash) setActive(window.location.hash.slice(1));
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.find((entry) => entry.isIntersecting);
        if (visible) setActive(visible.target.id);
      },
      { rootMargin: "-15% 0px -70%" },
    );
    for (const { id } of sections) {
      const section = document.getElementById(id);
      if (section) observer.observe(section);
    }
    return () => observer.disconnect();
  }, []);

  const selectSection = (id: string) => {
    setActive(id);
    window.history.replaceState(null, "", `#${id}`);
    document.getElementById(id)?.scrollIntoView();
  };

  return (
    <>
      <label className="settings-section-picker">
        {copy.settings.goToSection}
        <select value={active} onChange={(event) => selectSection(event.currentTarget.value)}>
          {sections.map(({ id, label }) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
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
    </>
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
      <div>
        <h2 id={id + "-title"}>{title}</h2>
        <p>{intro}</p>
      </div>
    </header>
  );
}
