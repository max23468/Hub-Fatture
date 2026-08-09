import { Form } from "react-router";

import { customerKindLabels, taxIdentifierLabels } from "../copy.it";
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
  const fields: Array<[string, string, string]> = [
    ["displayName", "Nome visualizzato", customer.displayName ?? ""],
    ["firstName", "Nome", customer.firstName ?? ""],
    ["lastName", "Cognome", customer.lastName ?? ""],
    ["companyName", "Ragione sociale", customer.companyName ?? ""],
    ["phone", "Telefono", customer.phone ?? ""],
    ["line1", "Indirizzo", address.line1 ?? ""],
    ["line2", "Indirizzo, seconda riga", address.line2 ?? ""],
    ["postalCode", "CAP", address.postalCode ?? ""],
    ["city", "Città", address.city ?? ""],
    ["province", "Provincia", address.province ?? ""],
  ];
  return (
    <section className="card section-gap">
      <h2>Anagrafica del destinatario</h2>
      <p>
        La correzione vale per questa preparazione. Gli ordini conservano il valore importato dalla
        piattaforma, che resta consultabile nel dettaglio dell’ordine.
      </p>
      <Form method="post" className="field-grid">
        <input type="hidden" name="csrf" value={csrfToken} />
        <input type="hidden" name="revision" value={revision} />
        <input type="hidden" name="intent" value="correct-customer" />
        <label>
          Tipo destinatario
          <select name="kind" defaultValue={customer.kind ?? "UNKNOWN"}>
            {Object.entries(customerKindLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {fields.map(([name, label, value]) => (
          <label key={name}>
            {label}
            <input defaultValue={value} name={name} />
          </label>
        ))}
        <label>
          E-mail
          <input defaultValue={customer.email ?? ""} name="email" type="email" />
        </label>
        <label>
          Paese
          <input
            defaultValue={address.countryCode ?? ""}
            maxLength={2}
            name="countryCode"
            placeholder="IT"
          />
        </label>
        {identifiers.map((identifier, index) => (
          <fieldset
            className="field-grid"
            key={`${identifier.type ?? "nuovo"}:${identifier.countryCode ?? ""}:${identifier.value ?? ""}`}
          >
            <legend>
              {index < identifiers.length - 1
                ? `Identificativo fiscale ${index + 1}`
                : "Nuovo identificativo fiscale"}
            </legend>
            <label>
              Tipo
              <select name="taxType" defaultValue={identifier.type ?? "CODICE_FISCALE"}>
                {Object.entries(taxIdentifierLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Valore, vuoto per rimuoverlo
              <input defaultValue={identifier.value ?? ""} name="taxValue" />
            </label>
            <label>
              Paese
              <input
                defaultValue={identifier.countryCode ?? ""}
                maxLength={2}
                name="taxCountryCode"
              />
            </label>
          </fieldset>
        ))}
        <label>
          Motivo della correzione
          <input maxLength={500} name="reason" />
        </label>
        <button className="button" type="submit">
          Salva anagrafica
        </button>
      </Form>
    </section>
  );
}
