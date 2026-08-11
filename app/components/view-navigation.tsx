import { useEffect, useRef } from "react";
import { Link } from "react-router";

export function ViewNavigation({
  active,
  label,
  items,
}: {
  active: string;
  label: string;
  items: ReadonlyArray<{ label: string; to: string; value: string }>;
}) {
  const activeLink = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    activeLink.current?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [active]);

  return (
    <nav className="view-nav" aria-label={label}>
      {items.map((item) => (
        <Link
          aria-current={active === item.value ? "page" : undefined}
          className="view-nav__item"
          key={item.value}
          ref={active === item.value ? activeLink : undefined}
          to={item.to}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
