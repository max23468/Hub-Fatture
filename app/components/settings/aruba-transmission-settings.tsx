import type { getArubaSettings } from "../../../src/db/aruba.server.ts";
import { copy } from "../../copy.it";
import { SettingsForm, SettingsSelect } from "../settings-controls";
import type { ErrorFor } from "./settings-types";

type ArubaSettings = Awaited<ReturnType<typeof getArubaSettings>>;

export function ArubaTransmissionSettings({
  aruba,
  canApprove,
  csrfToken,
  errorFor,
}: {
  aruba: ArubaSettings;
  canApprove: boolean;
  csrfToken: string;
  errorFor: ErrorFor;
}) {
  const error = errorFor("save-aruba");
  return (
    <>
      {canApprove ? (
        <section
          className="aruba-section-card settings-transmission-section"
          id="aruba-transmission"
          aria-labelledby="aruba-transmission-title"
        >
          <header className="aruba-section-card__header">
            <div>
              <h3 id="aruba-transmission-title">{copy.settings.arubaTransmissionTitle}</h3>
              <p>{copy.settings.arubaTransmissionHelp}</p>
            </div>
          </header>
          <SettingsForm
            accessibleSubmitLabel={copy.settings.arubaSave}
            className="settings-choice-card settings-choice-card--compact"
            key={aruba.mode.version}
            submitLabel={copy.settings.saveShort}
          >
            <input type="hidden" name="csrf" value={csrfToken} />
            <input type="hidden" name="intent" value="save-aruba" />
            <input type="hidden" name="arubaModeVersion" value={aruba.mode.version} />
            <label className="settings-choice-card__field">
              <span>{copy.settings.arubaMode}</span>
              <SettingsSelect
                data-initial={aruba.mode.value}
                defaultValue={aruba.mode.value}
                name="arubaMode"
              >
                <option value="DOCUMENT_ONLY">{copy.settings.arubaDocumentOnly}</option>
                <option value="CONTEXTUAL_CONFIRMATION">
                  {copy.settings.arubaContextualConfirmation}
                </option>
                <option value="AUTOMATIC_AFTER_APPROVAL">
                  {copy.settings.arubaAutomaticAfterApproval}
                </option>
              </SettingsSelect>
            </label>
          </SettingsForm>
        </section>
      ) : (
        <p>{copy.settings.arubaOwnerOnly}</p>
      )}
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}
