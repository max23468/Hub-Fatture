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
            onChange={(event) =>
              setFiles([
                ...(scenario === "foreign"
                  ? [{ name: "documento-estraneo.xml", valid: true }]
                  : []),
                ...[...(event.currentTarget.files ?? [])].map((file) => ({
                  name: file.name,
                  valid: scenario !== "invalid" && file.name.toLowerCase().endsWith(".xml"),
                })),
              ])
            }
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
                  <tr data-document-name={file.name} key={file.name}>
                    <td>{file.name}</td>
                    <td>{file.valid ? "Documento valido" : "Dettagli errori"}</td>
                    <td>
                      <button
                        className="button button--secondary"
                        onClick={() =>
                          setFiles((current) => current.filter((item) => item.name !== file.name))
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
