import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  CircleAlert,
  Clock3,
  ExternalLink,
  FileCheck2,
  Link2,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { useLayoutEffect, useRef, type RefObject } from "react";
import {
  data,
  Form,
  Link,
  redirect,
  useActionData,
  useLoaderData,
  useLocation,
  useNavigate,
} from "react-router";
import type { Route } from "./+types/controls";

import { AppShell } from "../components/app-shell";
import { ViewNavigation } from "../components/view-navigation";
import { copy } from "../copy.it";
import { dateTime } from "../format";
import { privateRouteMeta } from "../metadata";
import { ARUBA_IMPORT_MAX_BYTES } from "../../src/aruba.ts";
import { publicError } from "../../src/errors.ts";
import { assertCsrf, requestId, requireSessionUser } from "../../src/db/auth.server.ts";
import {
  confirmArubaDocumentOutOfScope,
  resolveArubaDocumentMatch,
} from "../../src/db/aruba-manual-decisions.server.ts";
import { importArubaRemoteOfficialFileAsActor } from "../../src/db/aruba-official-file-import.server.ts";
import { retryFailedJob } from "../../src/db/connector-jobs.server.ts";
import { completeShopifyDataRequest } from "../../src/db/connector-webhooks.server.ts";
import {
  readOperationalControls,
  markOperationalControlWaiting,
  resolveOperationalControl,
  type OperationalControl,
} from "../../src/db/operational-controls.server.ts";
import { readForm, readMultipartForm } from "../../src/http.server.ts";

const severities = ["BLOCKING", "IMPORTANT", "ORDINARY"] as const;
const origins = ["ORDERS", "DOCUMENTS", "CUSTOMERS", "CONNECTIONS", "PRIVACY"] as const;

export function meta({ error }: Route.MetaArgs) {
  return privateRouteMeta("controls", { error });
}

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireSessionUser(request);
  const url = new URL(request.url);
  const state = url.searchParams.get("vista") === "attesa" ? "WAITING" : "OPEN";
  const requestedSeverity = url.searchParams.get("gravita");
  const requestedOrigin = url.searchParams.get("origine");
  const requestedKind = url.searchParams.get("tipo")?.trim() ?? "";
  const selectedControlId = url.searchParams.get("id")?.trim() ?? "";
  const severity = severities.find((item) => item === requestedSeverity);
  const origin = origins.find((item) => item === requestedOrigin);
  const result = await readOperationalControls({
    state,
    severity,
    origin,
    kind: Object.hasOwn(copy.controls.kinds, requestedKind) ? requestedKind : undefined,
    selectedId: selectedControlId || undefined,
  });
  return {
    username: user.username,
    canApprove: user.canApprove,
    csrfToken: user.csrfToken,
    state,
    severity: severity ?? "",
    origin: origin ?? "",
    kind: Object.hasOwn(copy.controls.kinds, requestedKind) ? requestedKind : "",
    result,
    selectedControlId,
    outcome: url.searchParams.get("esito") ?? "",
  };
}

export async function action({ request }: Route.ActionArgs) {
  try {
    const user = await requireSessionUser(request);
    if (request.headers.get("content-type")?.toLowerCase().startsWith("multipart/form-data;")) {
      const form = await readMultipartForm(request, {
        maxBytes: ARUBA_IMPORT_MAX_BYTES + 64 * 1024,
      });
      assertCsrf(user, String(form.get("csrf") ?? ""));
      const file = form.get("file");
      if (!(file instanceof File)) throw new Response("File mancante", { status: 422 });
      const controlId = String(form.get("controlId") ?? "");
      await importArubaRemoteOfficialFileAsActor(
        String(form.get("remoteDocumentId") ?? ""),
        "ARUBA_XML",
        Buffer.from(await file.arrayBuffer()),
        {
          id: user.id,
          canApprove: user.canApprove,
          requestId: requestId(request),
        },
      );
      return redirect(`/controlli?id=${encodeURIComponent(controlId)}&esito=file-acquisito`);
    }
    const form = await readForm(request);
    assertCsrf(user, form.get("csrf") ?? "");
    const intent = form.get("intent") ?? "";
    const controlId = form.get("controlId") ?? "";
    const note = form.get("note") ?? "";
    const actor = {
      type: "ADMIN" as const,
      id: user.id,
      canApprove: user.canApprove,
      requestId: requestId(request),
    };
    if (intent === "retry-connector-job") {
      await retryFailedJob(form.get("jobId"), actor);
      await markOperationalControlWaiting(controlId, note);
      return redirect(`/controlli?vista=attesa&id=${encodeURIComponent(controlId)}&esito=attesa`);
    }
    if (intent === "complete-shopify-data-request") {
      await completeShopifyDataRequest(
        form.get("externalEventId"),
        form.get("privacyHandled"),
        actor,
      );
      await resolveOperationalControl(controlId, "PRIVACY_COMPLETED", note);
      return redirect("/controlli?esito=completato");
    }
    if (intent === "resolve-aruba-match") {
      await resolveArubaDocumentMatch(
        form.get("remoteDocumentId") ?? "",
        form.get("orderId") ?? "",
        form.get("reason"),
        form.get("amountMismatchConfirmation"),
        form.get("externalEvidenceConfirmation"),
        actor,
      );
      await resolveOperationalControl(controlId, "ARUBA_MATCHED", note);
      return redirect("/controlli?esito=completato");
    }
    if (intent === "confirm-aruba-out-of-scope") {
      await confirmArubaDocumentOutOfScope(
        form.get("remoteDocumentId") ?? "",
        form.get("reason"),
        form.get("candidateRejection"),
        actor,
      );
      await resolveOperationalControl(controlId, "ARUBA_OUT_OF_SCOPE", note);
      return redirect("/controlli?esito=completato");
    }
    throw new Response("Azione non supportata", { status: 400 });
  } catch (error) {
    if (error instanceof Response) throw error;
    const result = publicError(error);
    return data(result, { status: result.status });
  }
}

function controlLink(control: OperationalControl, search: URLSearchParams) {
  const next = new URLSearchParams(search);
  next.set("id", control.id);
  next.delete("esito");
  return `/controlli?${next.toString()}`;
}

function controlsListLink(search: URLSearchParams) {
  const query = search.toString();
  return query ? `/controlli?${query}` : "/controlli";
}

function ControlRow({
  control,
  onSelect,
  selected,
  search,
}: {
  control: OperationalControl;
  onSelect: () => void;
  selected: boolean;
  search: URLSearchParams;
}) {
  const Icon =
    control.severity === "BLOCKING"
      ? CircleAlert
      : control.state === "WAITING"
        ? Clock3
        : ShieldCheck;
  return (
    <Link
      aria-current={selected ? "true" : undefined}
      className={`control-row control-row--${control.severity.toLowerCase()}${selected ? " control-row--selected" : ""}`}
      data-control-id={control.id}
      onClick={onSelect}
      preventScrollReset
      state={{ fromControlsList: true }}
      to={controlLink(control, search)}
    >
      <span className="control-row__severity" aria-hidden="true">
        <Icon size={22} strokeWidth={1.9} />
      </span>
      <span className="control-row__copy">
        <strong>{control.title}</strong>
        <span>{control.detail}</span>
      </span>
      <span className="control-row__age">
        <small>
          {control.state === "WAITING" ? copy.controls.waitingSince : copy.controls.opened}
        </small>
        <time dateTime={control.waiting_at ?? control.opened_at}>
          {dateTime(control.waiting_at ?? control.opened_at)}
        </time>
      </span>
      <ArrowRight aria-hidden="true" size={18} strokeWidth={1.8} />
    </Link>
  );
}

function canLinkArubaRemoteDocument(control: OperationalControl) {
  const metadata = control.metadata_json;
  return (
    ["ARUBA_REMOTE_MATCH", "ARUBA_AMOUNT_MISMATCH", "ARUBA_EXTERNAL_EVIDENCE"].includes(
      control.kind,
    ) &&
    metadata.hasXml &&
    ["DELIVERED", "NOT_DELIVERED"].includes(metadata.remoteStatus ?? "") &&
    Boolean(metadata.candidates?.length)
  );
}

function canConfirmArubaOutOfScope(control: OperationalControl) {
  const metadata = control.metadata_json;
  return (
    metadata.hasXml &&
    ["DELIVERED", "NOT_DELIVERED"].includes(metadata.remoteStatus ?? "") &&
    ["PROFILE_CONFLICT", "UNMATCHED", "AMBIGUOUS"].includes(metadata.matchStatus ?? "")
  );
}

function ArubaExceptionalEvidenceFields({ kind }: { kind: string }) {
  if (kind === "ARUBA_AMOUNT_MISMATCH") {
    return (
      <>
        <label className="control-note">
          <span>{copy.controls.amountMismatchReason}</span>
          <textarea
            name="reason"
            rows={3}
            minLength={10}
            maxLength={500}
            required
            placeholder={copy.controls.amountMismatchReasonPlaceholder}
          />
        </label>
        <label className="control-action-form__confirmation">
          <input type="checkbox" name="amountMismatchConfirmation" value="confirmed" required />
          {copy.controls.confirmAmountMismatchLink}
        </label>
      </>
    );
  }
  if (kind === "ARUBA_EXTERNAL_EVIDENCE") {
    return (
      <>
        <label className="control-note">
          <span>{copy.controls.externalEvidenceReason}</span>
          <textarea
            name="reason"
            rows={3}
            minLength={10}
            maxLength={500}
            required
            placeholder={copy.controls.externalEvidenceReasonPlaceholder}
          />
        </label>
        <label className="control-action-form__confirmation">
          <input type="checkbox" name="externalEvidenceConfirmation" value="confirmed" required />
          {copy.controls.confirmExternalEvidenceLink}
        </label>
      </>
    );
  }
  return <input type="hidden" name="reason" value="Collegamento confermato da Controlli" />;
}

function ArubaLinkForm({ control, csrfToken }: { control: OperationalControl; csrfToken: string }) {
  const metadata = control.metadata_json;
  const exceptionalLink = ["ARUBA_AMOUNT_MISMATCH", "ARUBA_EXTERNAL_EVIDENCE"].includes(
    control.kind,
  );
  return (
    <Form className="control-action-form" method="post">
      <input type="hidden" name="csrf" value={csrfToken} />
      <input type="hidden" name="controlId" value={control.id} />
      <input type="hidden" name="intent" value="resolve-aruba-match" />
      <input type="hidden" name="remoteDocumentId" value={metadata.remoteDocumentId} />
      <label>
        {copy.controls.candidateOrder}
        <select name="orderId" required defaultValue="">
          <option value="" disabled>
            {copy.controls.candidateOrder}
          </option>
          {metadata.candidates?.map((candidate) => (
            <option value={candidate.id} key={candidate.id}>
              {candidate.label}
            </option>
          ))}
        </select>
      </label>
      <ArubaExceptionalEvidenceFields kind={control.kind} />
      <OptionalNote />
      <button className="button" type="submit">
        <Link2 aria-hidden="true" size={17} />
        {exceptionalLink ? copy.controls.linkArubaWithDifference : copy.controls.linkAruba}
      </button>
    </Form>
  );
}

function ArubaOutOfScopeForm({
  control,
  csrfToken,
}: {
  control: OperationalControl;
  csrfToken: string;
}) {
  const metadata = control.metadata_json;
  return (
    <Form className="control-action-form" method="post">
      <input type="hidden" name="csrf" value={csrfToken} />
      <input type="hidden" name="controlId" value={control.id} />
      <input type="hidden" name="intent" value="confirm-aruba-out-of-scope" />
      <input type="hidden" name="remoteDocumentId" value={metadata.remoteDocumentId} />
      <input type="hidden" name="reason" value={copy.controls.outOfScopeReason} />
      {metadata.candidates?.length ? (
        <label className="control-action-form__confirmation">
          <input type="checkbox" name="candidateRejection" value="confirmed" required />
          {copy.controls.confirmCandidateRejection}
        </label>
      ) : null}
      <OptionalNote />
      <button className="button button--secondary" type="submit">
        <ShieldCheck aria-hidden="true" size={17} />
        {copy.controls.confirmOutOfScope}
      </button>
    </Form>
  );
}

function ArubaRemoteMatchActions({
  control,
  csrfToken,
}: {
  control: OperationalControl;
  csrfToken: string;
}) {
  const canLink = canLinkArubaRemoteDocument(control);
  const canConfirmOutOfScope = canConfirmArubaOutOfScope(control);

  return (
    <div className="control-actions-grid">
      {canLink ? <ArubaLinkForm control={control} csrfToken={csrfToken} /> : null}
      {canConfirmOutOfScope ? (
        <ArubaOutOfScopeForm control={control} csrfToken={csrfToken} />
      ) : null}
    </div>
  );
}

function ControlActions({
  control,
  canApprove,
  csrfToken,
}: {
  control: OperationalControl;
  canApprove: boolean;
  csrfToken: string;
}) {
  const metadata = control.metadata_json;
  if (control.state === "WAITING") {
    return (
      <p className="control-detail__waiting">
        <Clock3 aria-hidden="true" size={18} />
        {copy.controls.actionWaiting}
      </p>
    );
  }
  if (control.kind === "CONNECTOR_JOB_FAILED" && metadata.jobId) {
    return (
      <Form className="control-action-form" method="post">
        <input type="hidden" name="csrf" value={csrfToken} />
        <input type="hidden" name="controlId" value={control.id} />
        <input type="hidden" name="intent" value="retry-connector-job" />
        <input type="hidden" name="jobId" value={metadata.jobId} />
        <OptionalNote />
        <button className="button" type="submit">
          <RefreshCw aria-hidden="true" size={17} />
          {copy.controls.retry}
        </button>
      </Form>
    );
  }
  if (control.kind === "SHOPIFY_PRIVACY_REQUEST" && metadata.privacyEventId) {
    return (
      <Form className="control-action-form" method="post">
        <input type="hidden" name="csrf" value={csrfToken} />
        <input type="hidden" name="controlId" value={control.id} />
        <input type="hidden" name="intent" value="complete-shopify-data-request" />
        <input type="hidden" name="externalEventId" value={metadata.privacyEventId} />
        <label className="control-action-form__confirmation">
          <input type="checkbox" name="privacyHandled" value="confirmed" required />
          {copy.controls.confirmPrivacy}
        </label>
        <OptionalNote />
        <button className="button" type="submit">
          <CheckCircle2 aria-hidden="true" size={17} />
          {copy.controls.completePrivacy}
        </button>
      </Form>
    );
  }
  if (
    ["ARUBA_REMOTE_MATCH", "ARUBA_AMOUNT_MISMATCH", "ARUBA_EXTERNAL_EVIDENCE"].includes(
      control.kind,
    ) &&
    metadata.remoteDocumentId &&
    canApprove
  ) {
    return <ArubaRemoteMatchActions control={control} csrfToken={csrfToken} />;
  }
  if (control.kind === "ARUBA_OFFICIAL_FILE_REQUIRED" && metadata.remoteDocumentId && canApprove) {
    return (
      <Form className="control-action-form" method="post" encType="multipart/form-data">
        <input type="hidden" name="csrf" value={csrfToken} />
        <input type="hidden" name="controlId" value={control.id} />
        <input type="hidden" name="intent" value="import-aruba-remote-file" />
        <input type="hidden" name="remoteDocumentId" value={metadata.remoteDocumentId} />
        <label>
          {copy.controls.officialXml}
          <input accept=".xml,application/xml" name="file" required type="file" />
        </label>
        <OptionalNote />
        <button className="button" type="submit">
          <FileCheck2 aria-hidden="true" size={17} />
          {copy.controls.importOfficialXml}
        </button>
      </Form>
    );
  }
  return (
    <Link className="button" to={control.href}>
      {control.primary_action}
      <ExternalLink aria-hidden="true" size={17} />
    </Link>
  );
}

function OptionalNote() {
  return (
    <label className="control-note">
      <span>{copy.controls.optionalNote}</span>
      <textarea name="note" rows={2} placeholder={copy.controls.optionalNotePlaceholder} />
    </label>
  );
}

function ControlDetail({
  control,
  canApprove,
  csrfToken,
  headingRef,
}: {
  control: OperationalControl | null;
  canApprove: boolean;
  csrfToken: string;
  headingRef?: RefObject<HTMLHeadingElement | null>;
}) {
  if (!control)
    return <div className="control-detail control-detail--empty">{copy.controls.noSelection}</div>;
  const metadata = control.metadata_json;
  return (
    <article className="control-detail" aria-labelledby="control-detail-title">
      <span className={`control-severity control-severity--${control.severity.toLowerCase()}`}>
        {copy.controls.severity[control.severity]}
      </span>
      <h2 id="control-detail-title" ref={headingRef} tabIndex={-1}>
        {control.title}
      </h2>
      <div className="control-consequence">
        <CircleAlert aria-hidden="true" size={20} strokeWidth={1.9} />
        <span>
          <strong>{copy.controls.consequence}</strong>
          {control.consequence}
        </span>
      </div>
      {metadata.facts?.length ? (
        <section className="control-evidence" aria-labelledby="control-evidence-title">
          <h3 id="control-evidence-title">{copy.controls.evidence}</h3>
          <dl>
            {metadata.facts.map((fact) => (
              <div key={`${fact.label}:${fact.value}`}>
                <dt>{fact.label}</dt>
                <dd className={fact.tone ? `control-fact--${fact.tone}` : undefined}>
                  {fact.value}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}
      <div className="control-detail__actions">
        <ControlActions control={control} canApprove={canApprove} csrfToken={csrfToken} />
        <Link className="dashboard-row-link" to={control.href}>
          <FileCheck2 aria-hidden="true" size={17} />
          {copy.controls.openSource}
        </Link>
      </div>
    </article>
  );
}

export default function Controls() {
  const {
    username,
    canApprove,
    csrfToken,
    state,
    severity,
    origin,
    kind,
    result,
    selectedControlId,
    outcome,
  } = useLoaderData<typeof loader>();
  const actionError = useActionData<typeof action>();
  const location = useLocation();
  const navigate = useNavigate();
  const hasExplicitSelection =
    selectedControlId !== "" && result.selected?.id === selectedControlId;
  const selectionScrollRef = useRef<number | null>(null);
  const listScrollRef = useRef<number | null>(null);
  const lastSelectedIdRef = useRef<string | null>(selectedControlId || null);
  const detailWasOpenRef = useRef(false);
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const detailHeadingRef = useRef<HTMLHeadingElement | null>(null);
  useLayoutEffect(() => {
    const compact = window.matchMedia("(max-width: 64rem)").matches;
    if (!compact) {
      if (selectionScrollRef.current === null) return;
      const scrollPosition = selectionScrollRef.current;
      selectionScrollRef.current = null;
      window.scrollTo(0, scrollPosition);
      let frame = 0;
      let remainingFrames = 3;
      const restoreScroll = () => {
        window.scrollTo(0, scrollPosition);
        remainingFrames -= 1;
        if (remainingFrames > 0) frame = window.requestAnimationFrame(restoreScroll);
      };
      frame = window.requestAnimationFrame(restoreScroll);
      return () => window.cancelAnimationFrame(frame);
    }

    if (hasExplicitSelection) {
      detailWasOpenRef.current = true;
      lastSelectedIdRef.current = selectedControlId;
      selectionScrollRef.current = null;
      window.scrollTo(0, 0);
      const frame = window.requestAnimationFrame(() => {
        window.scrollTo(0, 0);
        detailHeadingRef.current?.focus({ preventScroll: true });
      });
      return () => window.cancelAnimationFrame(frame);
    }

    if (!detailWasOpenRef.current) return;
    detailWasOpenRef.current = false;
    selectionScrollRef.current = null;
    const scrollPosition = listScrollRef.current;
    listScrollRef.current = null;
    const selectedId = lastSelectedIdRef.current;
    let frame = 0;
    let remainingFrames = scrollPosition === null ? 1 : 3;
    const restoreScroll = () => {
      if (scrollPosition !== null) window.scrollTo(0, scrollPosition);
      remainingFrames -= 1;
      if (remainingFrames > 0) {
        frame = window.requestAnimationFrame(restoreScroll);
        return;
      }
      if (!selectedId) return;
      const row = workspaceRef.current?.querySelector<HTMLAnchorElement>(
        `[data-control-id="${CSS.escape(selectedId)}"]`,
      );
      row?.focus({ preventScroll: scrollPosition !== null });
    };
    frame = window.requestAnimationFrame(restoreScroll);
    return () => window.cancelAnimationFrame(frame);
  }, [hasExplicitSelection, selectedControlId]);
  const search = new URLSearchParams();
  if (state === "WAITING") search.set("vista", "attesa");
  if (severity) search.set("gravita", severity);
  if (origin) search.set("origine", origin);
  if (kind) search.set("tipo", kind);
  const listLink = controlsListLink(search);
  const cameFromControlsList = Boolean(
    (location.state as { fromControlsList?: boolean } | null)?.fromControlsList,
  );
  const returnToList = () => {
    if (cameFromControlsList) {
      void navigate(-1);
      return;
    }
    void navigate(listLink, { preventScrollReset: true, replace: true });
  };
  return (
    <AppShell username={username} canApprove={canApprove} csrfToken={csrfToken}>
      <div className={`controls-page${hasExplicitSelection ? " controls-page--detail" : ""}`}>
        <div className="title-block controls-title">
          <p className="eyebrow">{copy.controls.eyebrow}</p>
          <h1>{copy.controls.title}</h1>
          <p>{copy.controls.intro}</p>
        </div>
        {hasExplicitSelection ? (
          <nav className="controls-mobile-detail-navigation" aria-label={copy.controls.backToList}>
            <button className="back-link controls-mobile-back" onClick={returnToList} type="button">
              <ArrowLeft aria-hidden="true" size={17} strokeWidth={1.8} />
              {copy.controls.backToList}
            </button>
          </nav>
        ) : null}
        <div className="controls-overview">
          <ViewNavigation
            active={state === "OPEN" ? "aperti" : "attesa"}
            label={copy.controls.viewsLabel}
            items={[
              {
                value: "aperti",
                label: `${copy.controls.open} ${result.summary.open}`,
                to: "/controlli",
              },
              {
                value: "attesa",
                label: `${copy.controls.waiting} ${result.summary.waiting}`,
                to: "/controlli?vista=attesa",
              },
            ]}
          />
          <dl className="controls-severity-summary" aria-label={copy.controls.severityLabel}>
            <div className="controls-severity-summary__blocking">
              <dt>{copy.controls.blocking}</dt>
              <dd>{result.summary.blocking}</dd>
            </div>
            <div className="controls-severity-summary__important">
              <dt>{copy.controls.important}</dt>
              <dd>{result.summary.important}</dd>
            </div>
            <div>
              <dt>{copy.controls.ordinary}</dt>
              <dd>{result.summary.ordinary}</dd>
            </div>
          </dl>
        </div>
        {outcome ? (
          <p className="notice notice--success" role="status">
            {outcome === "attesa"
              ? copy.controls.actionWaiting
              : outcome === "file-acquisito"
                ? copy.controls.fileAcquired
                : copy.controls.actionCompleted}
          </p>
        ) : null}
        {actionError && "message" in actionError ? (
          <p className="error" role="alert">
            {actionError.message}
          </p>
        ) : null}
        <div className="controls-toolbar">
          <Form className="controls-filters" method="get">
            {state === "WAITING" ? <input type="hidden" name="vista" value="attesa" /> : null}
            <label>
              <span>{copy.controls.severityLabel}</span>
              <select name="gravita" defaultValue={severity}>
                <option value="">{copy.controls.all}</option>
                {severities.map((value) => (
                  <option key={value} value={value}>
                    {copy.controls.severity[value]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>{copy.controls.kindLabel}</span>
              <select name="tipo" defaultValue={kind}>
                <option value="">{copy.controls.all}</option>
                {Object.entries(copy.controls.kinds).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>{copy.controls.originLabel}</span>
              <select name="origine" defaultValue={origin}>
                <option value="">{copy.controls.all}</option>
                {origins.map((value) => (
                  <option key={value} value={value}>
                    {copy.controls.origins[value]}
                  </option>
                ))}
              </select>
            </label>
            <button className="button button--secondary" type="submit">
              {copy.controls.applyFilters}
            </button>
          </Form>
        </div>
        {result.rows.length ? (
          <div
            className={`controls-workspace controls-workspace--${hasExplicitSelection ? "detail" : "list"}`}
            ref={workspaceRef}
          >
            <section className="controls-queue" aria-label={copy.controls.title}>
              {result.rows.map((control) => (
                <ControlRow
                  key={control.id}
                  control={control}
                  onSelect={() => {
                    selectionScrollRef.current = window.scrollY;
                    listScrollRef.current = window.scrollY;
                    lastSelectedIdRef.current = control.id;
                  }}
                  selected={control.id === result.selected?.id}
                  search={search}
                />
              ))}
            </section>
            <ControlDetail
              control={result.selected}
              canApprove={canApprove}
              csrfToken={csrfToken}
              headingRef={detailHeadingRef}
            />
          </div>
        ) : (
          <section className="dashboard-panel controls-empty">
            <CheckCircle2 aria-hidden="true" size={28} strokeWidth={1.8} />
            <span>
              <h2>{state === "OPEN" ? copy.controls.emptyOpen : copy.controls.emptyWaiting}</h2>
              <p>
                {state === "OPEN" ? copy.controls.emptyOpenHelp : copy.controls.emptyWaitingHelp}
              </p>
            </span>
          </section>
        )}
      </div>
    </AppShell>
  );
}
