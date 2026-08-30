import { Settings2 } from "lucide-react";

import { copy } from "../../copy.it";
import { SettingsForm, SettingsSectionHeader, SettingsSelect } from "../settings-controls";
import type { ErrorFor } from "./settings-types";

export function BillingSettingsSection({
  csrfToken,
  errorFor,
  saved,
  shopifyPaymentFeeMode,
  shopifyPaymentFeeModeSaved,
  trigger,
}: {
  csrfToken: string;
  errorFor: ErrorFor;
  saved: boolean;
  shopifyPaymentFeeMode: { value: "DEDUCT" | "INCLUDE"; version: number };
  shopifyPaymentFeeModeSaved: boolean;
  trigger: { value: "PAID" | "FULFILLED"; version: number };
}) {
  return (
    <section className="settings-section" id="fatturazione" aria-labelledby="fatturazione-title">
      <SettingsSectionHeader
        id="fatturazione"
        icon={Settings2}
        title={copy.settings.billingTitle}
        intro={copy.settings.billingHelp}
      />
      {saved ? (
        <p className="notice" role="status">
          {copy.settings.saved}
        </p>
      ) : null}
      <SettingsForm
        accessibleSubmitLabel={copy.settings.preparationSave}
        className="settings-choice-card"
        key={`trigger:${trigger.version}`}
        submitLabel={copy.settings.save}
      >
        <input type="hidden" name="csrf" value={csrfToken} />
        <input type="hidden" name="intent" value="save-trigger" />
        <input type="hidden" name="version" value={trigger.version} />
        <label className="settings-choice-card__field">
          <span className="settings-choice-card__title">{copy.settings.preparationLabel}</span>
          <span className="field-help">{copy.settings.preparationHelp}</span>
          <SettingsSelect data-initial={trigger.value} defaultValue={trigger.value} name="trigger">
            <option value="PAID">{copy.settings.onPaid}</option>
            <option value="FULFILLED">{copy.settings.onFulfilled}</option>
          </SettingsSelect>
        </label>
      </SettingsForm>
      {errorFor("save-trigger") ? (
        <p className="error" role="alert">
          {errorFor("save-trigger")}
        </p>
      ) : null}
      {shopifyPaymentFeeModeSaved ? (
        <p className="notice" role="status">
          {copy.settings.shopifyPaymentFeeModeSaved}
        </p>
      ) : null}
      <SettingsForm
        accessibleSubmitLabel={copy.settings.shopifyPaymentFeeModeSave}
        className="settings-choice-card"
        key={`shopify-payment-fees:${shopifyPaymentFeeMode.version}`}
        submitLabel={copy.settings.save}
      >
        <input type="hidden" name="csrf" value={csrfToken} />
        <input type="hidden" name="intent" value="save-shopify-payment-fee-mode" />
        <input
          type="hidden"
          name="shopifyPaymentFeeModeVersion"
          value={shopifyPaymentFeeMode.version}
        />
        <label className="settings-choice-card__field">
          <span className="settings-choice-card__title">
            {copy.settings.shopifyPaymentFeeModeLabel}
          </span>
          <span className="field-help">{copy.settings.shopifyPaymentFeeModeHelp}</span>
          <SettingsSelect
            data-initial={shopifyPaymentFeeMode.value}
            defaultValue={shopifyPaymentFeeMode.value}
            name="shopifyPaymentFeeMode"
          >
            <option value="DEDUCT">{copy.settings.shopifyPaymentFeeDeduct}</option>
            <option value="INCLUDE">{copy.settings.shopifyPaymentFeeInclude}</option>
          </SettingsSelect>
        </label>
      </SettingsForm>
      {errorFor("save-shopify-payment-fee-mode") ? (
        <p className="error" role="alert">
          {errorFor("save-shopify-payment-fee-mode")}
        </p>
      ) : null}
    </section>
  );
}
