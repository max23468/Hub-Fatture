import {
  ArrowRight,
  ClipboardCheck,
  Clock3,
  FileText,
  LoaderCircle,
  ReceiptText,
  Search,
  SearchX,
  ShoppingBag,
  UserRound,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Link } from "react-router";

import type { loader } from "../routes/search";
import { auditActionLabel, copy } from "../copy.it";
import { date, dateTime } from "../format";

type SearchData = Awaited<ReturnType<typeof loader>>["data"];

export function GlobalSearchResults({
  currentData,
  invalidResponse,
  loading,
  normalizedQuery,
  onNavigate,
}: {
  currentData: SearchData | undefined;
  invalidResponse: boolean;
  loading: boolean;
  normalizedQuery: string;
  onNavigate: () => void;
}) {
  const total = currentData
    ? Object.values(currentData.totals).reduce((sum, count) => sum + count, 0)
    : 0;
  if (normalizedQuery.length < 2) {
    return (
      <SearchMessage icon={Search} title={copy.search.startTitle} detail={copy.search.startHelp} />
    );
  }
  if (invalidResponse) {
    return (
      <SearchMessage
        detail={copy.search.errorHelp}
        error
        icon={SearchX}
        title={copy.search.errorTitle}
      />
    );
  }
  if (loading || !currentData) {
    return <SearchMessage icon={LoaderCircle} title={copy.search.loading} spinning />;
  }
  if (currentData.failed) {
    return (
      <SearchMessage
        detail={copy.search.errorHelp}
        error
        icon={SearchX}
        title={copy.search.errorTitle}
      />
    );
  }
  if (total === 0) {
    return (
      <SearchMessage
        detail={copy.search.emptyHelp(normalizedQuery)}
        icon={SearchX}
        title={copy.search.emptyTitle}
      />
    );
  }
  return (
    <>
      <p className="visually-hidden">{copy.search.results(total)}</p>
      <SearchGroup
        allHref={filteredHref("/ordini", normalizedQuery)}
        icon={ShoppingBag}
        id="ordini"
        label={copy.search.orders}
        total={currentData.totals.orders}
        items={currentData.orders.map((item) => ({
          id: item.id,
          href: item.href,
          title: copy.search.order(item.provider, item.displayNumber),
          detail: `${item.customerName} · ${date(item.localOrderDate)}`,
        }))}
        onNavigate={onNavigate}
      />
      <SearchGroup
        allHref={filteredHref("/controlli", normalizedQuery)}
        icon={ClipboardCheck}
        id="controlli"
        label={copy.search.controls}
        total={currentData.totals.controls}
        items={currentData.controls.map((item) => ({
          id: item.id,
          href: item.href,
          title: item.title,
          detail: item.detail,
          badge: copy.search.controlState[item.state],
        }))}
        onNavigate={onNavigate}
      />
      <SearchGroup
        allHref={filteredHref("/documenti", normalizedQuery, { vista: "fatture" })}
        icon={FileText}
        id="fatture"
        label={copy.search.invoices}
        total={currentData.totals.invoices}
        items={currentData.invoices.map((item) => ({
          id: item.id,
          href: item.href,
          title: item.fiscalLabel
            ? copy.search.invoice(item.fiscalLabel)
            : copy.search.invoicePreparation(item.caseNumber),
          detail: `${item.customerName} · ${date(item.documentDate)}`,
          badge: item.status === "APPROVED" ? copy.search.issued : copy.search.draft,
        }))}
        onNavigate={onNavigate}
      />
      <SearchGroup
        allHref={filteredHref("/documenti", normalizedQuery, { vista: "note-credito" })}
        icon={ReceiptText}
        id="note-credito"
        label={copy.search.creditNotes}
        total={currentData.totals.creditNotes}
        items={currentData.creditNotes.map((item) => ({
          id: item.id,
          href: item.href,
          title: copy.search.creditNote(item.fiscalLabel),
          detail: `${item.customerName} · ${date(item.documentDate)}`,
          badge: item.status === "APPROVED" ? copy.search.issued : copy.search.draft,
        }))}
        onNavigate={onNavigate}
      />
      <SearchGroup
        allHref={filteredHref("/clienti", normalizedQuery)}
        icon={UserRound}
        id="clienti"
        label={copy.search.customers}
        total={currentData.totals.customers}
        items={currentData.customers.map((item) => ({
          id: item.id,
          href: item.href,
          title: item.displayName,
          detail: item.email ?? item.taxId ?? copy.search.noContact,
          badge: copy.search.customerOrders(item.orderCount),
        }))}
        onNavigate={onNavigate}
      />
      <SearchGroup
        allHref={filteredHref("/attivita", normalizedQuery, { vista: "cronologia" })}
        icon={Clock3}
        id="cronologia"
        label={copy.search.history}
        total={currentData.totals.history}
        items={currentData.history.map((item) => ({
          id: item.id,
          href: item.href,
          title: auditActionLabel(item.action) ?? item.action,
          detail: `${copy.search.historySubject(item.subject)} · ${dateTime(item.createdAt)}`,
        }))}
        onNavigate={onNavigate}
      />
      <SearchGroup
        allHref={filteredHref("/documenti", normalizedQuery, { vista: "inventario-aruba" })}
        icon={FileText}
        id="documenti-aruba"
        label={copy.search.remoteDocuments}
        total={currentData.totals.remoteDocuments}
        items={currentData.remoteDocuments.map((item) => ({
          id: item.id,
          href: item.href,
          title: item.fiscalNumber
            ? copy.search.remoteDocument(
                item.documentType,
                [item.series, item.fiscalNumber].filter(Boolean).join(" "),
              )
            : copy.search.remoteDocumentWithoutNumber(item.documentType),
          detail: `${item.remoteId} · ${date(item.documentDate)}`,
          badge: copy.documents.matchStatusLabels[item.matchStatus] ?? item.matchStatus,
        }))}
        onNavigate={onNavigate}
      />
    </>
  );
}

function SearchMessage({
  detail,
  error = false,
  icon: Icon,
  spinning = false,
  title,
}: {
  detail?: string;
  error?: boolean;
  icon: LucideIcon;
  spinning?: boolean;
  title: string;
}) {
  return (
    <div
      className={`global-search__empty${error ? " global-search__empty--error" : ""}`}
      role={error ? "alert" : undefined}
    >
      <Icon
        aria-hidden="true"
        className={spinning ? "global-search__spinner" : undefined}
        size={26}
        strokeWidth={1.7}
      />
      <strong>{title}</strong>
      {detail ? <span>{detail}</span> : null}
    </div>
  );
}

function SearchGroup({
  allHref,
  icon: Icon,
  id,
  items,
  label,
  onNavigate,
  total,
}: {
  allHref: string;
  icon: LucideIcon;
  id: string;
  items: Array<{ id: string; href: string; title: string; detail: string; badge?: string }>;
  label: string;
  onNavigate: () => void;
  total: number;
}) {
  if (!total) return null;
  return (
    <section className="global-search__group" aria-labelledby={`ricerca-${id}`}>
      <h2 id={`ricerca-${id}`}>
        {label}
        <span>{total}</span>
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
      {total > items.length ? (
        <Link className="global-search__all" onClick={onNavigate} to={allHref}>
          {copy.search.viewAll(label, total)}
          <ArrowRight aria-hidden="true" size={16} strokeWidth={1.8} />
        </Link>
      ) : null}
    </section>
  );
}

function filteredHref(path: string, query: string, extra?: Record<string, string>) {
  const params = new URLSearchParams({ ...extra, q: query });
  return `${path}?${params.toString()}`;
}
