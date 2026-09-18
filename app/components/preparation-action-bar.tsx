import { useEffect, useState } from "react";

/** La barra resta ancorata al fondo finché l'azione non entra nell'area visibile. */
export function PreparationActionBar({
  action,
  detail,
  label,
  targetId,
}: {
  action: string;
  detail: string;
  label: string;
  targetId: string;
}) {
  const [reached, setReached] = useState(false);

  useEffect(() => {
    const target = document.getElementById(targetId);
    if (!target) return;
    const observer = new IntersectionObserver(([entry]) =>
      setReached(Boolean(entry?.isIntersecting)),
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [targetId]);

  if (reached) return null;
  return (
    <aside className="preparation-action-bar" aria-label={label}>
      <span className="preparation-action-bar__label">
        <strong>{label}</strong>
        <small>{detail}</small>
      </span>
      <a className="button preparation-action-bar__link" href={`#${targetId}`}>
        {action}
      </a>
    </aside>
  );
}
