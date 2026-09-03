import { Link } from "react-router";

import { anomalyLabels, copy } from "../copy.it";

export function PreparationAnomalies({ codes }: { codes: string[] }) {
  if (!codes.length) return null;
  return (
    <section className="card section-gap" aria-labelledby="anomalie">
      <h2 id="anomalie">{copy.preparation.checksTitle}</h2>
      <ul className="plain-list">
        {codes.map((code) => (
          <li className="preparation-check" key={code}>
            <span className="preparation-check__copy">
              <strong>{anomalyLabels[code]?.title ?? "Verifica richiesta"}</strong>
              <span>{anomalyLabels[code]?.action ?? copy.preparation.checkFallback}</span>
            </span>
            {code === "ARUBA_POTENTIAL_MATCH" ? (
              <Link
                className="button button--secondary preparation-check__action"
                to="/controlli?origine=DOCUMENTS"
              >
                {copy.preparation.openArubaCandidates}
              </Link>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
