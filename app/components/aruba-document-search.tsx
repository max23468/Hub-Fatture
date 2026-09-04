import { Search, SlidersHorizontal } from "lucide-react";
import { useState } from "react";
import { Form, useNavigation } from "react-router";

import { copy } from "../copy.it";

function submittingIntent(formData: FormData | undefined, intent: string) {
  return formData?.get("intent") === intent;
}

export function ArubaDocumentSearch({ csrfToken }: { csrfToken: string }) {
  const navigation = useNavigation();
  const [lookupType, setLookupType] = useState<"filename" | "idSdi">("filename");
  const lookupPending = submittingIntent(navigation.formData, "lookup-aruba-document");
  const advancedPending = submittingIntent(navigation.formData, "search-aruba-documents");

  return (
    <div className="remote-search-tools">
      <section className="remote-search-card" aria-labelledby="remote-lookup-title">
        <header className="remote-search-card__header">
          <span className="remote-search-card__icon" aria-hidden="true">
            <Search size={20} strokeWidth={1.8} />
          </span>
          <div>
            <h3 id="remote-lookup-title">{copy.documents.verifyOnAruba}</h3>
            <p>{copy.documents.arubaDetailHelp}</p>
          </div>
        </header>
        <Form className="remote-lookup-form" method="post">
          <input name="csrf" type="hidden" value={csrfToken} />
          <input name="intent" type="hidden" value="lookup-aruba-document" />
          <div className="remote-lookup-form__fields">
            <label>
              {copy.documents.lookupBy}
              <select
                name="lookupType"
                value={lookupType}
                onChange={(event) =>
                  setLookupType(event.currentTarget.value as "filename" | "idSdi")
                }
              >
                <option value="filename">{copy.documents.providerFilename}</option>
                <option value="idSdi">{copy.documents.sdiId}</option>
              </select>
            </label>
            <label className="remote-lookup-form__value">
              {lookupType === "filename" ? copy.documents.providerFilename : copy.documents.sdiId}
              <input name="lookupValue" required maxLength={255} />
            </label>
          </div>
          <div className="remote-search-card__actions">
            <span aria-live="polite">{lookupPending ? copy.documents.searchArubaPending : ""}</span>
            <button className="button button--secondary" disabled={lookupPending} type="submit">
              {lookupPending ? copy.documents.searchArubaPending : copy.documents.verifyOnAruba}
            </button>
          </div>
        </Form>
      </section>

      <details className="remote-search-card remote-advanced-search">
        <summary>
          <span className="remote-search-card__icon" aria-hidden="true">
            <SlidersHorizontal size={20} strokeWidth={1.8} />
          </span>
          <span>
            <strong>{copy.documents.advancedArubaSearch}</strong>
            <small>{copy.documents.advancedArubaSearchHelp}</small>
          </span>
        </summary>
        <Form method="post">
          <input name="csrf" type="hidden" value={csrfToken} />
          <input name="intent" type="hidden" value="search-aruba-documents" />
          <div className="remote-advanced-search__groups">
            <fieldset>
              <legend>{copy.documents.advancedArubaPrimaryGroup}</legend>
              <div>
                <label>
                  {copy.documents.creationStart}
                  <input name="creationStart" required type="datetime-local" />
                </label>
                <label>
                  {copy.documents.creationEnd}
                  <input name="creationEnd" required type="datetime-local" />
                </label>
                <label>
                  {copy.documents.remoteUpdatedFrom}
                  <input name="modifiedStart" type="datetime-local" />
                </label>
                <label>
                  {copy.documents.remoteUpdatedTo}
                  <input name="modifiedEnd" type="datetime-local" />
                </label>
              </div>
            </fieldset>
            <fieldset>
              <legend>{copy.documents.advancedArubaRecipientGroup}</legend>
              <div>
                <label>
                  {copy.documents.recipientCountry}
                  <input maxLength={2} name="receiverCountry" placeholder="IT" />
                </label>
                <label>
                  {copy.documents.vatOnly}
                  <input name="receiverVatCode" />
                </label>
                <label>
                  {copy.documents.fiscalCodeOnly}
                  <input name="receiverFiscalCode" />
                </label>
              </div>
            </fieldset>
            <fieldset>
              <legend>{copy.documents.advancedArubaDocumentGroup}</legend>
              <div>
                <label>
                  {copy.documents.type}
                  <select name="remoteDocumentType">
                    <option value="">{copy.documents.allTypes}</option>
                    <option value="TD01">TD01</option>
                    <option value="TD04">TD04</option>
                  </select>
                </label>
                <label>
                  {copy.documents.arubaStatus}
                  <select name="remoteStatus">
                    <option value="">{copy.documents.allStatuses}</option>
                    {copy.documents.providerStatuses.map((status) => (
                      <option key={status} value={status}>
                        {status}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </fieldset>
          </div>
          <div className="remote-search-card__actions">
            <span aria-live="polite">
              {advancedPending ? copy.documents.searchArubaPending : ""}
            </span>
            <button className="button" disabled={advancedPending} type="submit">
              {advancedPending ? copy.documents.searchArubaPending : copy.documents.verifyOnAruba}
            </button>
          </div>
        </Form>
      </details>
    </div>
  );
}
