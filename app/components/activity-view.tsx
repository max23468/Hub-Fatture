import { ArrowRight, CircleAlert, Clock3, RefreshCw, ShieldCheck } from "lucide-react";
import { Form, Link } from "react-router";

import { auditActionLabel, auditActionLabels, copy } from "../copy.it";
import { compactDate, compactDateTime, dateTime } from "../format";

interface OpenActivity {
  kind: string;
  id: string;
  reason: string;
  case_number: string | null;
  order_number: string | null;
  provider: string | null;
  customer_name: string | null;
  error_code: string | null;
  order_date: string | null;
  href: string;
  created_at: string;
}

interface OpenActivityPage {
  rows: OpenActivity[];
  hasNext: boolean;
  total: number;
}

interface FailedJob {
  id: string;
  type: string;
  attempts: number;
  errorCode: string | null;
  createdAt: string;
}

interface HistoryEvent {
  id: string;
  action: string;
  actor_type: string;
  actor_username: string | null;
  entity_type: string;
  entity_id: string | null;
  order_provider: string | null;
  order_number: string | null;
  case_number: string | null;
  refund_order_id: string | null;
  reason: string | null;
  created_at: string;
}

function ActivityOverview({ failedJobs, open }: { failedJobs: number; open: OpenActivityPage }) {
  const total = open.total + failedJobs;
  return (
    <section
      className="dashboard-panel activity-overview section-gap"
      aria-label={copy.activity.overviewLabel}
    >
      <div className="activity-overview__lead">
        <span className="dashboard-icon dashboard-icon--warning" aria-hidden="true">
          <CircleAlert size={24} strokeWidth={1.9} />
        </span>
        <span>
          <strong>{copy.activity.attentionCount(total)}</strong>
          <span>{copy.activity.attentionHelp}</span>
        </span>
      </div>
      <dl className="activity-overview__counts">
        <div>
          <dt>{copy.activity.reviewsCount}</dt>
          <dd>{open.total}</dd>
        </div>
        <div>
          <dt>{copy.activity.failedJobsCount}</dt>
          <dd>{failedJobs}</dd>
        </div>
      </dl>
    </section>
  );
}

function ReviewActivitiesPanel({ open }: { open: OpenActivityPage }) {
  if (!open.rows.length) return null;
  return (
    <section className="dashboard-panel activity-panel" aria-labelledby="activity-review-title">
      <header className="activity-panel__header">
        <span className="dashboard-icon dashboard-icon--warning" aria-hidden="true">
          <CircleAlert size={22} strokeWidth={1.8} />
        </span>
        <span>
          <h2 id="activity-review-title">{copy.activity.reviewTitle}</h2>
          <p>{copy.activity.reviewHelp}</p>
        </span>
        <strong className="activity-panel__count">{open.total}</strong>
      </header>
      <div className="table-wrap activity-table-wrap">
        <table className="activity-table">
          <colgroup>
            <col className="activity-table__item-column" />
            <col className="activity-table__customer-column" />
            <col className="activity-table__channel-column" />
            <col className="activity-table__order-date-column" />
            <col className="activity-table__updated-column" />
            <col className="activity-table__action-column" />
          </colgroup>
          <thead>
            <tr>
              <th>{copy.activity.item}</th>
              <th>{copy.activity.customer}</th>
              <th>{copy.activity.channelOrType}</th>
              <th>{copy.activity.orderDate}</th>
              <th>{copy.activity.lastUpdated}</th>
              <th>
                <span className="activity-table__action-label">{copy.activity.actions}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {open.rows.map((activity) => {
              const provider =
                activity.provider === "SHOPIFY"
                  ? "Shopify"
                  : activity.provider === "EBAY"
                    ? "eBay"
                    : null;
              const subject =
                activity.kind === "CREDIT_NOTE"
                  ? copy.activity.creditNoteKind
                  : activity.case_number
                    ? copy.activity.preparationShort(activity.case_number)
                    : activity.kind === "REFUND" || activity.kind === "REFUND_JOB"
                      ? copy.activity.refund(provider ?? "—", activity.order_number ?? activity.id)
                      : copy.activity.order(provider ?? "—", activity.order_number ?? activity.id);
              const context =
                activity.reason === "HISTORY_RECONCILIATION" ||
                activity.reason === "ARUBA_INVOICE_LINK" ||
                activity.reason === "REFUND_JOB_FAILED"
                  ? copy.activity.openActivityReasons[activity.reason]
                  : null;
              const channelOrType = activity.error_code
                ? copy.activity.errorDetail(activity.error_code)
                : activity.kind === "CREDIT_NOTE"
                  ? copy.activity.creditNoteKind
                  : (provider ?? copy.activity.preparationKind);
              return (
                <tr key={`${activity.kind}:${activity.id}`}>
                  <td data-label={copy.activity.item}>
                    <span className="activity-row__main">
                      <Link to={activity.href}>{subject}</Link>
                      {context ? <small className="activity-row__context">{context}</small> : null}
                    </span>
                  </td>
                  <td data-label={copy.activity.customer}>
                    <strong
                      className="activity-table__truncate"
                      title={activity.customer_name ?? copy.activity.customerToVerify}
                    >
                      {activity.customer_name ?? copy.activity.customerToVerify}
                    </strong>
                  </td>
                  <td
                    data-label={
                      activity.error_code ? copy.activity.error : copy.activity.channelOrType
                    }
                  >
                    <strong className="activity-table__truncate" title={channelOrType}>
                      {channelOrType}
                    </strong>
                  </td>
                  <td data-label={copy.activity.orderDate}>
                    {activity.order_date ? (
                      <time dateTime={activity.order_date}>{compactDate(activity.order_date)}</time>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td data-label={copy.activity.lastUpdated}>
                    <time dateTime={activity.created_at}>
                      {compactDateTime(activity.created_at)}
                    </time>
                  </td>
                  <td data-label={copy.activity.actions} className="activity-table__action">
                    <Link className="dashboard-row-link" to={activity.href}>
                      <span>{copy.activity.openItem}</span>
                      <ArrowRight aria-hidden="true" size={17} strokeWidth={1.8} />
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function FailedJobsPanel({ csrfToken, jobs }: { csrfToken: string; jobs: FailedJob[] }) {
  if (!jobs.length) return null;
  return (
    <section className="dashboard-panel activity-panel" aria-labelledby="activity-jobs-title">
      <header className="activity-panel__header">
        <span className="dashboard-icon dashboard-icon--warning" aria-hidden="true">
          <RefreshCw size={22} strokeWidth={1.8} />
        </span>
        <span>
          <h2 id="activity-jobs-title">{copy.activity.failedJobsTitle}</h2>
          <p>{copy.activity.failedJobsHelp}</p>
        </span>
        <strong className="activity-panel__count">{jobs.length}</strong>
      </header>
      <ul className="activity-list">
        {jobs.map((job) => (
          <li className="activity-row" key={job.id}>
            <span className="activity-row__main">
              <small className="activity-row__reason">{copy.activity.failedJobsTitle}</small>
              <strong>{copy.activity.failedJobTitle(job.type)}</strong>
            </span>
            <span className="activity-row__facts">
              <span>
                <small>{copy.activity.error}</small>
                <strong>{copy.activity.errorDetail(job.errorCode)}</strong>
              </span>
              <span>
                <small>{copy.activity.attempts}</small>
                <strong>{job.attempts}</strong>
              </span>
              <span>
                <small>{copy.activity.failedAt}</small>
                <time dateTime={job.createdAt}>{dateTime(job.createdAt)}</time>
              </span>
            </span>
            <Form method="post">
              <input type="hidden" name="csrf" value={csrfToken} />
              <input type="hidden" name="intent" value="retry-connector-job" />
              <input type="hidden" name="jobId" value={job.id} />
              <button className="button button--secondary" type="submit">
                {copy.activity.retryJob}
              </button>
            </Form>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ActivityEmpty() {
  return (
    <section className="dashboard-panel activity-empty section-gap">
      <span className="dashboard-icon dashboard-icon--success" aria-hidden="true">
        <ShieldCheck size={24} strokeWidth={1.9} />
      </span>
      <span>
        <h2>{copy.activity.nothingToManage}</h2>
        <p>{copy.activity.nothingToManageHelp}</p>
      </span>
      <div className="empty-state__actions">
        <Link className="button button--secondary" to="/attivita?vista=cronologia">
          {copy.activity.openHistory}
        </Link>
        <Link className="button button--secondary" to="/impostazioni#connessioni">
          {copy.activity.openConnections}
        </Link>
      </div>
    </section>
  );
}

export function ManageActivityView({
  csrfToken,
  failedJobs,
  open,
}: {
  csrfToken: string;
  failedJobs: FailedJob[];
  open: OpenActivityPage;
}) {
  if (!open.total && !failedJobs.length) return <ActivityEmpty />;
  return (
    <>
      <ActivityOverview failedJobs={failedJobs.length} open={open} />
      <div className="activity-stack">
        <ReviewActivitiesPanel open={open} />
        <FailedJobsPanel csrfToken={csrfToken} jobs={failedJobs} />
      </div>
    </>
  );
}

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
}: {
  action: string;
  events: HistoryEvent[];
  query: string;
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
        <input type="hidden" name="vista" value="cronologia" />
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
            <Link className="dashboard-row-link" to="/attivita?vista=cronologia">
              {copy.activity.clearFilters}
            </Link>
          ) : null}
        </span>
      </Form>
      {events.length ? (
        <div className="table-wrap table-wrap--history">
          <table>
            <thead>
              <tr>
                <th>{copy.activity.activity}</th>
                <th>{copy.activity.subject}</th>
                <th>{copy.activity.author}</th>
                <th>{copy.activity.when}</th>
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
                    <time dateTime={event.created_at}>{dateTime(event.created_at)}</time>
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
