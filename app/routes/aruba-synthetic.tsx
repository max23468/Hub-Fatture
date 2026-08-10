import { useEffect, useState } from "react";
import type { Route } from "./+types/aruba-synthetic";

import { getConfig } from "../../src/config.server.ts";

export function loader({ request }: Route.LoaderArgs) {
  if (getConfig().APP_ENV === "production") throw new Response("Non disponibile", { status: 404 });
  return {
    scenario: new URL(request.url).searchParams.get("scenario") ?? "valid",
    accountReference: getConfig().ARUBA_ACCOUNT_REFERENCE,
  };
}

interface UploadedFile {
  name: string;
  valid: boolean;
  fiscalNumber?: string;
  documentDate?: string;
  totalCents?: number;
  url?: string;
}

async function uploadedFile(file: File, valid: boolean): Promise<UploadedFile> {
  const url = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result)), { once: true });
    reader.addEventListener("error", () => reject(reader.error), { once: true });
    reader.readAsDataURL(file);
  });
  if (!valid) return { name: file.name, valid: false, url };
  const xml = new DOMParser().parseFromString(await file.text(), "application/xml");
  const value = (localName: string) =>
    [...xml.getElementsByTagNameNS("*", localName)][0]?.textContent?.trim();
  const total = Number(value("ImportoTotaleDocumento"));
  return {
    name: file.name,
    valid:
      !xml.querySelector("parsererror") &&
      Boolean(value("Numero") && value("Data")) &&
      Number.isFinite(total),
    fiscalNumber: value("Numero"),
    documentDate: value("Data"),
    totalCents: Math.round(total * 100),
    url,
  };
}

export default function ArubaSynthetic({ loaderData }: Route.ComponentProps) {
  const scenario = loaderData.scenario;
  const accountReference = loaderData.accountReference;
  const [authenticated, setAuthenticated] = useState(!["login", "login-auto"].includes(scenario));
  const [files, setFiles] = useState<UploadedFile[]>(
    scenario === "foreign" ? [{ name: "documento-estraneo.xml", valid: true }] : [],
  );
  const [sent, setSent] = useState(false);
  useEffect(() => {
    if (scenario !== "login-auto") return;
    const timer = window.setTimeout(() => {
      window.location.search = "?scenario=valid";
    }, 250);
    return () => window.clearTimeout(timer);
  }, [scenario]);

  if (!authenticated) {
    return (
      <main className="auth-shell" data-aruba-state="login-required">
        <section className="card">
          <h1>Accesso richiesto</h1>
          <p>Completa manualmente password, OTP o CAPTCHA. L’helper resta in pausa.</p>
          <button className="button" onClick={() => setAuthenticated(true)} type="button">
            Autenticazione completata
          </button>
        </section>
      </main>
    );
  }
  if (scenario === "unexpected") {
    return (
      <main className="auth-shell" data-aruba-state="unexpected">
        <section className="card">
          <h1>Pagina non riconosciuta</h1>
        </section>
      </main>
    );
  }

  const invalid = files.some((file) => !file.valid);
  return (
    <main
      className="app-main"
      data-aruba-state={
        sent ? (scenario === "uncertain" ? "uncertain" : "submitted") : "upload-ready"
      }
    >
      <div className="title-block">
        <p className="eyebrow">Pagina sintetica locale</p>
        <h1>Carica fatture da inviare</h1>
        <p>Questa pagina non comunica con Aruba e usa soltanto documenti sintetici.</p>
        <p data-aruba-account={accountReference}>Account: {accountReference}</p>
      </div>
      <section className="card">
        <label>
          Seleziona documenti
          <input
            accept=".xml,application/xml"
            multiple
            onChange={async (event) => {
              const selected = [...(event.currentTarget.files ?? [])];
              setFiles([
                ...(scenario === "foreign"
                  ? [{ name: "documento-estraneo.xml", valid: true }]
                  : []),
                ...(await Promise.all(
                  selected.map((file) =>
                    uploadedFile(
                      file,
                      scenario !== "invalid" && file.name.toLowerCase().endsWith(".xml"),
                    ),
                  ),
                )),
              ]);
            }}
            type="file"
          />
        </label>
        {files.length ? (
          <div className="table-wrap section-gap">
            <table>
              <caption>Documenti caricati</caption>
              <thead>
                <tr>
                  <th>File</th>
                  <th>Validazione</th>
                  <th>Azione</th>
                </tr>
              </thead>
              <tbody>
                {files.map((file) => (
                  <tr
                    data-document-date={file.documentDate}
                    data-document-name={file.name}
                    data-fiscal-number={file.fiscalNumber}
                    data-remote-id={sent && scenario !== "uncertain" ? "MOCK-001" : undefined}
                    data-total-cents={file.totalCents}
                    key={file.name}
                  >
                    <td>
                      {file.name}
                      {file.fiscalNumber && file.documentDate && file.totalCents !== undefined
                        ? ` · ${file.fiscalNumber} · ${file.documentDate} · ${(file.totalCents / 100).toFixed(2)}`
                        : ""}
                    </td>
                    <td>
                      {sent && scenario !== "uncertain"
                        ? "Inviato · ID Aruba: MOCK-001"
                        : file.valid
                          ? "Documento valido"
                          : "Dettagli errori"}
                    </td>
                    <td>
                      {sent && scenario !== "uncertain" && file.url ? (
                        <a download={file.name} href={file.url}>
                          Scarica XML
                        </a>
                      ) : null}
                      <button
                        className="button button--secondary"
                        onClick={() =>
                          setFiles((current) => {
                            return current.filter((item) => item.name !== file.name);
                          })
                        }
                        type="button"
                      >
                        Rimuovi
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {invalid ? <p className="error">Uno o più documenti contengono errori.</p> : null}
        {sent ? (
          <p role="status">
            {scenario === "uncertain" ? "Stato non disponibile" : "Documenti acquisiti · MOCK-001"}
          </p>
        ) : (
          <button
            className="button section-gap"
            disabled={!files.length || invalid}
            onClick={() => setSent(true)}
            type="button"
          >
            Invia
          </button>
        )}
        <button className="button button--secondary section-gap" disabled type="button">
          Salva in bozze
        </button>
      </section>
    </main>
  );
}
