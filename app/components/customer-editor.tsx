import { Form } from "react-router";

import { copy, customerKindLabels, taxIdentifierLabels } from "../copy.it";
import type { EditableCustomer } from "../../src/db/orders.server.ts";

/**
 * Correzione anagrafica prima dell'approvazione (7.5). Il modulo riparte sempre dallo snapshot
 * corrente e dichiara la revisione letta: una seconda scheda riceve conflitto invece di vincere.
 * Ogni identificativo fiscale esistente ha la propria riga, così salvare una correzione non
 * fiscale non cancella gli identificativi che il modulo non stava modificando.
 */
export function CustomerEditor({
  csrfToken,
  customer,
  revision,
}: {
  csrfToken: string;
  customer: EditableCustomer;
  revision: number;
}) {
  const address = customer.billingAddress ?? {};
  const identifiers = [...(customer.taxIdentifiers ?? []), {}];
  const identityFields: Array<[string, string, string, string?]> = [
    ["displayName", copy.customerEditor.displayName, customer.displayName ?? ""],
    ["firstName", copy.customerEditor.firstName, customer.firstName ?? ""],
    ["lastName", copy.customerEditor.lastName, customer.lastName ?? ""],
    ["companyName", copy.customerEditor.companyName, customer.companyName ?? ""],
    ["phone", copy.customerEditor.phone, customer.phone ?? ""],
    ["email", copy.customerEditor.email, customer.email ?? "", "email"],
  ];
  const addressFields: Array<[string, string, string]> = [
    ["line1", copy.customerEditor.line1, address.line1 ?? ""],
    ["line2", copy.customerEditor.line2, address.line2 ?? ""],
    ["postalCode", copy.customerEditor.postalCode, address.postalCode ?? ""],
    ["city", copy.customerEditor.city, address.city ?? ""],
    ["province", copy.customerEditor.province, address.province ?? ""],
  ];
  return (
    <section className="card section-gap">
      <h2>{copy.customerEditor.title}</h2>
      <p>{copy.customerEditor.intro}</p>
      <Form method="post" className="customer-form">
        <input type="hidden" name="csrf" value={csrfToken} />
        <input type="hidden" name="revision" value={revision} />
        <input type="hidden" name="intent" value="correct-customer" />
        <fieldset className="form-section">
          <legend>{copy.customerEditor.identity}</legend>
          <div className="form-grid">
            <label>
              {copy.customerEditor.kind}
              <select name="kind" defaultValue={customer.kind ?? "UNKNOWN"}>
                {Object.entries(customerKindLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            {identityFields.map(([name, label, value, type]) => (
              <label key={name}>
                {label}
                <input defaultValue={value} name={name} type={type} />
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="form-section">
          <legend>{copy.customerEditor.address}</legend>
          <div className="form-grid">
            {addressFields.map(([name, label, value]) => (
              <label key={name}>
                {label}
                <input defaultValue={value} name={name} />
              </label>
            ))}
            <div className="field-with-help">
              <label>
                {copy.customerEditor.country}
                <input
                  aria-describedby="country-help"
                  defaultValue={address.countryCode ?? ""}
                  maxLength={2}
                  name="countryCode"
                  placeholder="IT"
                />
              </label>
              <small className="field-help" id="country-help">
                {copy.customerEditor.countryHelp}
              </small>
            </div>
          </div>
        </fieldset>
        <fieldset className="form-section">
          <legend>{copy.customerEditor.tax}</legend>
          <div className="tax-identifiers">
            {identifiers.map((identifier, index) => (
              <fieldset
                className="tax-identifier"
                key={`${identifier.type ?? "nuovo"}:${identifier.countryCode ?? ""}:${identifier.value ?? ""}`}
              >
                <legend>
                  {index < identifiers.length - 1
                    ? copy.customerEditor.identifier(index + 1)
                    : copy.customerEditor.newIdentifier}
                </legend>
                <label>
                  {copy.customerEditor.type}
                  <select name="taxType" defaultValue={identifier.type ?? "CODICE_FISCALE"}>
                    {Object.entries(taxIdentifierLabels).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="field-with-help">
                  <label>
                    {copy.customerEditor.value}
                    <input
                      aria-describedby={`tax-value-help-${index}`}
                      defaultValue={identifier.value ?? ""}
                      name="taxValue"
                    />
                  </label>
                  <small className="field-help" id={`tax-value-help-${index}`}>
                    {copy.customerEditor.emptyRemoves}
                  </small>
                </div>
                <label>
                  {copy.customerEditor.country}
                  <input
                    defaultValue={identifier.countryCode ?? ""}
                    maxLength={2}
                    name="taxCountryCode"
                    placeholder="IT"
                  />
                </label>
              </fieldset>
            ))}
          </div>
        </fieldset>
        <div className="form-actions">
          <label>
            {copy.customerEditor.reason}
            <input maxLength={500} name="reason" />
          </label>
          <button className="button" type="submit">
            {copy.customerEditor.save}
          </button>
        </div>
      </Form>
    </section>
  );
}
