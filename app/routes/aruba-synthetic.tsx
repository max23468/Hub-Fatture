import {
  CircleAlert,
  CircleHelp,
  CloudUpload,
  Download,
  FileCheck2,
  Save,
  Send,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Route } from "./+types/aruba-synthetic";

import { DetailSectionHeader } from "../components/detail-section-header";
import { copy } from "../copy.it";
import { privateRouteMeta } from "../metadata";
import { getConfig } from "../../src/config.server.ts";

export function meta({ error }: Route.MetaArgs) {
  return privateRouteMeta("arubaSynthetic", { error });
}

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
  const pendingFiles = useRef<UploadedFile[]>([]);
  const [challengeStep, setChallengeStep] = useState<"CONFIRM" | "CODE" | null>(null);
  const [challengeCode, setChallengeCode] = useState("");
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
      <main className="synthetic-page synthetic-page--state" data-aruba-state="login-required">
        <section className="dashboard-panel synthetic-state-card">
          <span className="dashboard-icon dashboard-icon--warning" aria-hidden="true">
            <ShieldCheck size={24} strokeWidth={1.8} />
          </span>
          <div>
            <p className="eyebrow">{copy.arubaSynthetic.eyebrow}</p>
            <h1>{copy.arubaSynthetic.loginTitle}</h1>
            <p>{copy.arubaSynthetic.loginHelp}</p>
          </div>
          <button className="button" onClick={() => setAuthenticated(true)} type="button">
            {copy.arubaSynthetic.loginAction}
          </button>
        </section>
      </main>
    );
  }
  if (scenario === "unexpected") {
    return (
      <main className="synthetic-page synthetic-page--state" data-aruba-state="unexpected">
        <section className="dashboard-panel synthetic-state-card">
          <span className="dashboard-icon dashboard-icon--warning" aria-hidden="true">
            <CircleHelp size={24} strokeWidth={1.8} />
          </span>
          <div>
            <p className="eyebrow">{copy.arubaSynthetic.eyebrow}</p>
            <h1>{copy.arubaSynthetic.unexpectedTitle}</h1>
            <p>{copy.arubaSynthetic.unexpectedHelp}</p>
          </div>
          <a className="button button--secondary" href="/aruba-sintetica">
            {copy.arubaSynthetic.backToSimulator}
          </a>
        </section>
      </main>
    );
  }

  const invalid = files.some((file) => !file.valid);
  return (
    <main
      className="synthetic-page"
      data-aruba-state={
        sent ? (scenario === "uncertain" ? "uncertain" : "submitted") : "upload-ready"
      }
    >
      <header className="synthetic-header">
        <div className="title-block">
          <p className="eyebrow">{copy.arubaSynthetic.eyebrow}</p>
          <h1>{copy.arubaSynthetic.title}</h1>
          <p>{copy.arubaSynthetic.intro}</p>
        </div>
        <p className="synthetic-account" data-aruba-account={accountReference}>
          <ShieldCheck aria-hidden="true" size={18} strokeWidth={1.8} />
          <span>{copy.arubaSynthetic.account(accountReference)}</span>
        </p>
      </header>
      <section className="dashboard-panel synthetic-upload-panel">
        <DetailSectionHeader
          description={copy.arubaSynthetic.uploadHelp}
          icon={<CloudUpload size={22} strokeWidth={1.8} />}
          title={copy.arubaSynthetic.uploadTitle}
        />
        <label className="synthetic-file-picker">
          <span>{copy.arubaSynthetic.selectDocuments}</span>
          <span className="synthetic-file-picker__control">
            <span className="dashboard-row-link">
              <CloudUpload aria-hidden="true" size={17} strokeWidth={1.8} />
              {copy.arubaSynthetic.browseDocuments}
            </span>
            <span>
              {files.length
                ? copy.arubaSynthetic.selectedDocuments(files.length)
                : copy.arubaSynthetic.noDocumentsSelected}
            </span>
          </span>
          <input
            accept=".xml,application/xml"
            aria-label={copy.arubaSynthetic.selectDocuments}
            className="visually-hidden"
            multiple
            onChange={async (event) => {
              const selected = [...(event.currentTarget.files ?? [])];
              const uploaded = [
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
              ];
              if (scenario === "security-challenge") {
                pendingFiles.current = uploaded;
                setChallengeStep("CONFIRM");
              } else {
                setFiles(uploaded);
              }
            }}
            type="file"
          />
        </label>
        {challengeStep ? (
          <dialog
            aria-labelledby="security-challenge-dialog-title"
            data-aruba-state="security-challenge-required"
            open
          >
            <div className="synthetic-dialog__content">
              <span className="dashboard-icon dashboard-icon--warning" aria-hidden="true">
                <ShieldCheck size={22} strokeWidth={1.8} />
              </span>
              {challengeStep === "CONFIRM" ? (
                <>
                  <h2 id="security-challenge-dialog-title">{copy.arubaSynthetic.otpQuestion}</h2>
                  <button className="button" onClick={() => setChallengeStep("CODE")} type="button">
                    {copy.arubaSynthetic.continue}
                  </button>
                </>
              ) : (
                <>
                  <h2 id="security-challenge-dialog-title">
                    {copy.arubaSynthetic.verificationTitle}
                  </h2>
                  <label>
                    {copy.arubaSynthetic.smsCode}
                    <input
                      inputMode="numeric"
                      onChange={(event) => setChallengeCode(event.currentTarget.value)}
                      value={challengeCode}
                    />
                  </label>
                  <button
                    className="button"
                    disabled={!/^\d{6}$/.test(challengeCode)}
                    onClick={() => {
                      setFiles(pendingFiles.current);
                      setChallengeStep(null);
                    }}
                    type="button"
                  >
                    {copy.arubaSynthetic.verify}
                  </button>
                </>
              )}
            </div>
          </dialog>
        ) : null}
        {files.length ? (
          <div className="table-wrap synthetic-documents">
            <table>
              <caption>{copy.arubaSynthetic.uploadedDocuments}</caption>
              <thead>
                <tr>
                  <th>{copy.arubaSynthetic.file}</th>
                  <th>{copy.arubaSynthetic.validation}</th>
                  <th>{copy.arubaSynthetic.action}</th>
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
                    <td data-label={copy.arubaSynthetic.file}>
                      <strong className="synthetic-document__name">{file.name}</strong>
                      {file.fiscalNumber && file.documentDate && file.totalCents !== undefined ? (
                        <small>
                          {file.fiscalNumber} · {file.documentDate} ·{" "}
                          {(file.totalCents / 100).toFixed(2)}
                        </small>
                      ) : null}
                    </td>
                    <td data-label={copy.arubaSynthetic.validation}>
                      {sent && scenario !== "uncertain"
                        ? copy.arubaSynthetic.sent
                        : file.valid
                          ? copy.arubaSynthetic.valid
                          : copy.arubaSynthetic.invalid}
                    </td>
                    <td
                      className="synthetic-document__actions"
                      data-label={copy.arubaSynthetic.action}
                    >
                      {sent && scenario !== "uncertain" && file.url ? (
                        <a download={file.name} href={file.url}>
                          <Download aria-hidden="true" size={17} strokeWidth={1.8} />
                          {copy.arubaSynthetic.download}
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
                        <Trash2 aria-hidden="true" size={17} strokeWidth={1.8} />
                        {copy.arubaSynthetic.remove}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {invalid ? (
          <p className="error synthetic-status">
            <CircleAlert aria-hidden="true" size={19} strokeWidth={1.8} />
            {copy.arubaSynthetic.invalidNotice}
          </p>
        ) : null}
        {sent ? (
          <p className="synthetic-status" role="status">
            <FileCheck2 aria-hidden="true" size={19} strokeWidth={1.8} />
            {scenario === "uncertain"
              ? copy.arubaSynthetic.uncertain
              : copy.arubaSynthetic.acquired}
          </p>
        ) : (
          <div className="synthetic-actions">
            <button
              className="button"
              disabled={!files.length || invalid}
              onClick={() => setSent(true)}
              type="button"
            >
              <Send aria-hidden="true" size={17} strokeWidth={1.8} />
              {copy.arubaSynthetic.send}
            </button>
            <button className="button button--secondary" disabled type="button">
              <Save aria-hidden="true" size={17} strokeWidth={1.8} />
              {copy.arubaSynthetic.saveDrafts}
            </button>
          </div>
        )}
      </section>
    </main>
  );
}
