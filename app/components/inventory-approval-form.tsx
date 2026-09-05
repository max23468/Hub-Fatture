import { useEffect, useState, type ReactNode } from "react";
import { useFetcher } from "react-router";

import { copy } from "../copy.it";

/** La conferma resta in memoria soltanto in questa pagina e per due minuti. */
export function InventoryApprovalForm({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const fetcher = useFetcher<{ code: string; message: string }>();
  const [submission, setSubmission] = useState<{ form: FormData; expiresAt: number } | null>(null);
  const [expired, setExpired] = useState(false);
  const refreshing = fetcher.data?.code === "ARUBA_INVENTORY_REFRESHING";
  const waiting = Boolean(submission && refreshing && !expired);
  const busy = fetcher.state !== "idle" || waiting;

  useEffect(() => {
    if (!submission || !refreshing || expired || fetcher.state !== "idle") return;
    const timer = window.setTimeout(() => {
      if (Date.now() >= submission.expiresAt) {
        setExpired(true);
        return;
      }
      // Si ripete solo la conferma originale: revisione e hash non vengono aggiornati.
      void fetcher.submit(submission.form, { method: "post" });
    }, 3_000);
    return () => window.clearTimeout(timer);
  }, [submission, refreshing, expired, fetcher]);

  return (
    <fetcher.Form
      method="post"
      className={className}
      aria-busy={busy}
      onSubmit={(event) => {
        if (busy) {
          event.preventDefault();
          return;
        }
        const submitter = (event.nativeEvent as SubmitEvent).submitter;
        setSubmission({
          form: new FormData(event.currentTarget, submitter),
          expiresAt: Date.now() + 120_000,
        });
        setExpired(false);
      }}
    >
      <fieldset
        aria-label={copy.document.approvalTitle}
        disabled={busy}
        className="inventory-approval-fields"
      >
        {children}
      </fieldset>
      {busy ? (
        <p className="notice" role="status">
          {copy.document.inventoryChecking}
        </p>
      ) : null}
      {expired ? (
        <p className="warning" role="alert">
          {copy.document.inventoryWaitExpired}
        </p>
      ) : null}
      {fetcher.state === "idle" && fetcher.data && !refreshing ? (
        <p className="error" role="alert">
          {fetcher.data.message}
        </p>
      ) : null}
    </fetcher.Form>
  );
}
