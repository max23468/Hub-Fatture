import { Search, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";

import { copy } from "../copy.it";
import { isSearchData, type SearchData } from "../search-data";
import { GlobalSearchResults } from "./global-search-results";

export function GlobalSearch() {
  const fetcher = useFetcher<SearchData>();
  const loadResults = fetcher.load;
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [query, setQuery] = useState("");
  const closeTimerRef = useRef<number>(undefined);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const normalizedQuery = query.trim();
  const responseMatchesQuery = fetcher.data?.query === normalizedQuery;
  const currentData = responseMatchesQuery && isSearchData(fetcher.data) ? fetcher.data : undefined;
  const invalidResponse = responseMatchesQuery && !currentData;

  const openSearch = useCallback(() => {
    if (closeTimerRef.current !== undefined) window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = undefined;
    setClosing(false);
    setOpen(true);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  const dismissSearch = useCallback((returnFocus = false) => {
    if (closeTimerRef.current !== undefined) window.clearTimeout(closeTimerRef.current);
    const finish = () => {
      closeTimerRef.current = undefined;
      setOpen(false);
      setClosing(false);
      if (returnFocus) requestAnimationFrame(() => triggerRef.current?.focus());
    };
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      finish();
      return;
    }
    setClosing(true);
    closeTimerRef.current = window.setTimeout(finish, 160);
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (open && event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        dismissSearch(true);
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        openSearch();
      }
    }
    function onPointerDown(event: PointerEvent) {
      if (open && !closing && !rootRef.current?.contains(event.target as Node)) {
        dismissSearch();
      }
    }
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [closing, dismissSearch, open, openSearch]);

  useEffect(
    () => () => {
      if (closeTimerRef.current !== undefined) window.clearTimeout(closeTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    if (normalizedQuery.length < 2) return;
    const timeout = window.setTimeout(() => {
      void loadResults(`/ricerca?q=${encodeURIComponent(normalizedQuery)}`);
    }, 180);
    return () => window.clearTimeout(timeout);
  }, [loadResults, normalizedQuery]);

  return (
    <div className="global-search" ref={rootRef}>
      <button
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={copy.search.open}
        className="global-search__trigger"
        onClick={openSearch}
        ref={triggerRef}
        type="button"
      >
        <Search aria-hidden="true" size={19} strokeWidth={1.9} />
        <span>{copy.search.trigger}</span>
      </button>
      {open ? (
        <>
          <div
            aria-hidden="true"
            className="global-search__backdrop"
            data-state={closing ? "closing" : "open"}
            onPointerDown={() => dismissSearch()}
          />
          <dialog
            open
            aria-label={copy.search.title}
            className="global-search__panel"
            data-state={closing ? "closing" : "open"}
          >
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
              <GlobalSearchResults
                currentData={currentData}
                invalidResponse={invalidResponse}
                loading={fetcher.state !== "idle"}
                normalizedQuery={normalizedQuery}
                onNavigate={() => dismissSearch()}
              />
            </div>
            <div className="global-search__footer">
              <span>{copy.search.keyboardHelp}</span>
              <button onClick={() => dismissSearch(true)} type="button">
                Esc
              </button>
            </div>
          </dialog>
        </>
      ) : null}
    </div>
  );
}
