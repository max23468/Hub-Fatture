import { BrandLockup } from "./brand-lockup";
import { copy } from "../copy.it";

export function PublicPage({
  children,
  compact = false,
}: {
  children: React.ReactNode;
  compact?: boolean;
}) {
  return (
    <main className={`public-page${compact ? " public-page--compact" : ""}`}>
      <header className="public-page__brand">
        <BrandLockup />
        <p>{copy.publicPage.intro}</p>
      </header>
      <div className="public-page__content">{children}</div>
    </main>
  );
}

export function PublicCardHeader({
  description,
  eyebrow,
  icon,
  title,
  titleId,
}: {
  description?: string;
  eyebrow: string;
  icon: React.ReactNode;
  title: string;
  titleId: string;
}) {
  return (
    <header className="public-card__header">
      <span className="dashboard-icon dashboard-icon--accent" aria-hidden="true">
        {icon}
      </span>
      <span>
        <p className="eyebrow">{eyebrow}</p>
        <h1 id={titleId}>{title}</h1>
        {description ? <p>{description}</p> : null}
      </span>
    </header>
  );
}
