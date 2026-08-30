import {
  ArrowRight,
  FileText,
  LoaderCircle,
  Search,
  SearchX,
  ShoppingBag,
  UserRound,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useFetcher } from "react-router";

import type { loader } from "../routes/search";
import { copy } from "../copy.it";
import { date } from "../format";

type SearchData = Awaited<ReturnType<typeof loader>>["data"];

export function GlobalSearch() {
  const fetcher = useFetcher<SearchData>();
  const loadResults = fetcher.load;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const normalizedQuery = query.trim();
  const currentData = fetcher.data?.query === normalizedQuery ? fetcher.data : undefined;
  const total = currentData
    ? currentData.orders.length + currentData.documents.length + currentData.customers.length
    : 0;

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (open && event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeAndReturnFocus();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen(true);
        requestAnimationFrame(() => inputRef.current?.focus());
      }
    }
    function onPointerDown(event: PointerEvent) {
      if (open && !rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  useEffect(() => {
    if (normalizedQuery.length < 2) return;
    const timeout = window.setTimeout(() => {
      void loadResults(`/ricerca?q=${encodeURIComponent(normalizedQuery)}`);
    }, 180);
    return () => window.clearTimeout(timeout);
  }, [loadResults, normalizedQuery]);

  function closeAndReturnFocus() {
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  }

  return (
    <div className="global-search" ref={rootRef}>
      <button
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={copy.search.open}
        className="global-search__trigger"
        onClick={() => {
          setOpen(true);
          requestAnimationFrame(() => inputRef.current?.focus());
        }}
        ref={triggerRef}
        type="button"
      >
        <Search aria-hidden="true" size={19} strokeWidth={1.9} />
        <span>{copy.search.trigger}</span>
      </button>
      {open ? (
        <dialog open aria-label={copy.search.title} className="global-search__panel">
          <div className="global-search__field">
            <Search aria-hidden="true" size={20} strokeWidth={1.9} />
            <label className="visually-hidden" htmlFor="ricerca-globale">
              {copy.search.label}
            </label>
            <input
              autoComplete="off"
              id="ricerca-globale"
              maxLength={100}
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder={copy.search.placeholder}
              ref={inputRef}
              type="search"
              value={query}
            />
            {query ? (
              <button
                aria-label={copy.search.clear}
                className="global-search__clear"
                onClick={() => {
                  setQuery("");
                  inputRef.current?.focus();
                }}
                type="button"
              >
                <X aria-hidden="true" size={18} strokeWidth={1.9} />
              </button>
            ) : null}
          </div>
          <div aria-live="polite" className="global-search__results">
            {normalizedQuery.length < 2 ? (
              <div className="global-search__empty">
                <Search aria-hidden="true" size={26} strokeWidth={1.6} />
                <strong>{copy.search.startTitle}</strong>
                <span>{copy.search.startHelp}</span>
              </div>
            ) : fetcher.state !== "idle" || !currentData ? (
              <div className="global-search__empty">
                <LoaderCircle
                  aria-hidden="true"
                  className="global-search__spinner"
                  size={26}
                  strokeWidth={1.7}
                />
                <strong>{copy.search.loading}</strong>
              </div>
            ) : currentData.failed ? (
              <div className="global-search__empty global-search__empty--error" role="alert">
                <SearchX aria-hidden="true" size={26} strokeWidth={1.7} />
                <strong>{copy.search.errorTitle}</strong>
                <span>{copy.search.errorHelp}</span>
              </div>
            ) : total === 0 ? (
              <div className="global-search__empty">
                <SearchX aria-hidden="true" size={26} strokeWidth={1.7} />
                <strong>{copy.search.emptyTitle}</strong>
                <span>{copy.search.emptyHelp(normalizedQuery)}</span>
              </div>
            ) : (
              <>
                <p className="visually-hidden">{copy.search.results(total)}</p>
                <SearchGroup
                  icon={ShoppingBag}
                  label={copy.search.orders}
                  items={currentData.orders.map((item) => ({
                    id: item.id,
                    href: item.href,
                    title: copy.search.order(item.provider, item.displayNumber),
                    detail: `${item.customerName} · ${date(item.localOrderDate)}`,
                  }))}
                  onNavigate={() => setOpen(false)}
                />
                <SearchGroup
                  icon={FileText}
                  label={copy.search.invoices}
                  items={currentData.documents.map((item) => ({
                    id: item.id,
                    href: item.href,
                    title: item.fiscalLabel
                      ? copy.search.invoice(item.fiscalLabel)
                      : copy.search.invoicePreparation(item.caseNumber),
                    detail: `${item.customerName} · ${date(item.documentDate)}`,
                    badge: item.status === "APPROVED" ? copy.search.issued : copy.search.draft,
                  }))}
                  onNavigate={() => setOpen(false)}
                />
                <SearchGroup
                  icon={UserRound}
                  label={copy.search.customers}
                  items={currentData.customers.map((item) => ({
                    id: item.id,
                    href: item.href,
                    title: item.displayName,
                    detail: item.email ?? item.taxId ?? copy.search.noContact,
                    badge: copy.search.customerOrders(item.orderCount),
                  }))}
                  onNavigate={() => setOpen(false)}
                />
              </>
            )}
          </div>
          <div className="global-search__footer">
            <span>{copy.search.keyboardHelp}</span>
            <button onClick={closeAndReturnFocus} type="button">
              Esc
            </button>
          </div>
        </dialog>
      ) : null}
    </div>
  );
}

function SearchGroup({
  icon: Icon,
  items,
  label,
  onNavigate,
}: {
  icon: typeof Search;
  items: Array<{ id: string; href: string; title: string; detail: string; badge?: string }>;
  label: string;
  onNavigate: () => void;
}) {
  if (!items.length) return null;
  return (
    <section className="global-search__group" aria-labelledby={`ricerca-${label}`}>
      <h2 id={`ricerca-${label}`}>
        {label}
        <span>{items.length}</span>
      </h2>
      <div>
        {items.map((item) => (
          <Link className="global-search__result" key={item.id} onClick={onNavigate} to={item.href}>
            <span className="global-search__result-icon" aria-hidden="true">
              <Icon size={19} strokeWidth={1.8} />
            </span>
            <span className="global-search__result-copy">
              <strong>{item.title}</strong>
              <span>{item.detail}</span>
            </span>
            {item.badge ? <small>{item.badge}</small> : null}
            <ArrowRight aria-hidden="true" size={17} strokeWidth={1.8} />
          </Link>
        ))}
      </div>
    </section>
  );
}
