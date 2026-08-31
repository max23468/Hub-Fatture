import { Link, useSearchParams } from "react-router";

import { copy } from "../copy.it";

/** Conserva i filtri correnti e cambia soltanto la pagina: un link condiviso resta valido. */
export function Pager({
  basePath,
  hasNext,
  page,
}: {
  basePath: string;
  hasNext: boolean;
  page: number;
}) {
  const [searchParams] = useSearchParams();
  if (page <= 1 && !hasNext) return null;
  const linkTo = (target: number) => {
    const next = new URLSearchParams(searchParams);
    if (target <= 1) next.delete("pagina");
    else next.set("pagina", String(target));
    const query = next.toString();
    return query ? `${basePath}?${query}` : basePath;
  };
  return (
    <nav aria-label={copy.pager.label} className="pager">
      {page > 1 ? (
        <Link className="button button--secondary" rel="prev" to={linkTo(page - 1)} viewTransition>
          {copy.pager.previous}
        </Link>
      ) : null}
      <span>{copy.pager.current(page)}</span>
      {hasNext ? (
        <Link className="button button--secondary" rel="next" to={linkTo(page + 1)} viewTransition>
          {copy.pager.next}
        </Link>
      ) : null}
    </nav>
  );
}
