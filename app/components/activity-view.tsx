import { Clock3 } from "lucide-react";
import { Form, Link } from "react-router";

import { SortableHeaderLink } from "./sortable-table";
import { auditActionLabel, auditActionLabels, copy } from "../copy.it";
import { dateTime, isoDateTime } from "../format";
import type { SortState } from "../table-sort";
import type { AuditHistorySortKey, listAuditHistory } from "../../src/db/order-queries.server.ts";

type HistoryEvent = Awaited<ReturnType<typeof listAuditHistory>>["rows"][number];

function HistorySubject({ event }: { event: HistoryEvent }) {
  if (event.entity_type === "BILLING_CASE" && event.entity_id && event.case_number) {
    return (
      <Link to={`/ordini/preparazione/${event.entity_id}`}>
        {copy.activity.preparation(event.case_number)}
      </Link>
    );
  }
  if (event.entity_type === "ORDER" && event.entity_id && event.order_number) {
    return (
      <Link to={`/ordini/${event.entity_id}`}>
        {copy.activity.order(
          event.order_provider === "SHOPIFY" ? "Shopify" : "eBay",
          event.order_number,
        )}
      </Link>
    );
  }
  if (event.entity_type === "SETTING") return copy.activity.settings;
  if (event.entity_type === "REFUND" && event.refund_order_id) {
    return (
      <Link to={`/ordini/${event.refund_order_id}`}>
        {copy.activity.order(
          event.order_provider === "SHOPIFY" ? "Shopify" : "eBay",
          event.order_number ?? event.refund_order_id,
        )}
      </Link>
    );
  }
  return "—";
}

export function ActivityHistoryView({
  action,
  events,
  query,
  sort,
}: {
  action: string;
  events: HistoryEvent[];
  query: string;
  sort: SortState<AuditHistorySortKey>;
}) {
  const hasFilters = Boolean(query || action);
  return (
    <section
      className="dashboard-panel activity-history-panel section-gap"
      aria-labelledby="activity-history-title"
    >
      <header className="activity-panel__header activity-history-panel__header">
        <span className="dashboard-icon dashboard-icon--neutral" aria-hidden="true">
          <Clock3 size={22} strokeWidth={1.8} />
        </span>
        <span>
          <h2 id="activity-history-title">{copy.activity.historyTitle}</h2>
          <p>{copy.activity.historyHelp}</p>
        </span>
        <strong className="activity-panel__count">
          {copy.activity.historyCount(events.length)}
        </strong>
      </header>
      <Form
        method="get"
        className="filters activity-filters"
        role="search"
        aria-label={copy.activity.searchLabel}
      >
        <label>
          {copy.activity.search}
          <input name="q" defaultValue={query} placeholder={copy.activity.searchPlaceholder} />
        </label>
        <label>
          {copy.activity.type}
          <select name="azione" defaultValue={action}>
            <option value="">{copy.activity.all}</option>
            {Object.entries(auditActionLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <span className="activity-filters__actions">
          <button className="button button--secondary" type="submit">
            {copy.activity.filter}
          </button>
          {hasFilters ? (
            <Link className="dashboard-row-link" to="/attivita">
              {copy.activity.clearFilters}
            </Link>
          ) : null}
        </span>
      </Form>
      {events.length ? (
        <div className="table-wrap table-wrap--history">
          <table className="activity-history-table data-table">
            <colgroup>
              <col className="activity-history-table__activity" />
              <col className="activity-history-table__subject" />
              <col className="activity-history-table__author" />
              <col className="activity-history-table__when" />
            </colgroup>
            <thead>
              <tr>
                <SortableHeaderLink
                  directionParam="direzione"
                  keyParam="ordina"
                  label={copy.activity.activity}
                  sort={sort}
                  sortKey="attivita"
                />
                <SortableHeaderLink
                  directionParam="direzione"
                  keyParam="ordina"
                  label={copy.activity.subject}
                  sort={sort}
                  sortKey="elemento"
                />
                <SortableHeaderLink
                  directionParam="direzione"
                  keyParam="ordina"
                  label={copy.activity.author}
                  sort={sort}
                  sortKey="autore"
                />
                <SortableHeaderLink
                  directionParam="direzione"
                  keyParam="ordina"
                  label={copy.activity.when}
                  sort={sort}
                  sortKey="quando"
                />
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr key={event.id}>
                  <td data-label={copy.activity.activity}>
                    <span className="activity-history__event">
                      <strong>{auditActionLabel(event.action) ?? copy.activity.recorded}</strong>
                      {event.reason ? (
                        <small>
                          {copy.activity.reason}: {event.reason}
                        </small>
                      ) : null}
                    </span>
                  </td>
                  <td data-label={copy.activity.subject}>
                    <HistorySubject event={event} />
                  </td>
                  <td data-label={copy.activity.author}>
                    {event.actor_type === "SYSTEM"
                      ? copy.activity.system
                      : (event.actor_username ?? "—")}
                  </td>
                  <td data-label={copy.activity.when}>
                    <time dateTime={isoDateTime(event.created_at)}>
                      {dateTime(event.created_at)}
                    </time>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty-state">
          <h2>{copy.activity.noHistory}</h2>
          <p>{copy.activity.noHistoryHelp}</p>
        </div>
      )}
    </section>
  );
}
