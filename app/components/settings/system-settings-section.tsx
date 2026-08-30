import { ShieldCheck } from "lucide-react";

import type { getSystemStatus } from "../../../src/db/system.server.ts";
import { copy } from "../../copy.it";
import { dateTime } from "../../format";
import { SettingsSectionHeader } from "../settings-controls";

export function SystemSettingsSection({
  environment,
  system,
}: {
  environment: string;
  system: Awaited<ReturnType<typeof getSystemStatus>>;
}) {
  return (
    <section className="settings-section" id="sistema" aria-labelledby="sistema-title">
      <SettingsSectionHeader
        id="sistema"
        icon={ShieldCheck}
        title={copy.settings.systemTitle}
        intro={copy.settings.systemHelp}
      />
      <div className="system-groups">
        <section className="system-group settings-inset-card">
          <h3>{copy.settings.systemOperations}</h3>
          <dl className="facts">
            <div>
              <dt>{copy.settings.environment}</dt>
              <dd>{copy.settings.environmentLabel(environment)}</dd>
            </div>
            <div>
              <dt>{copy.settings.timeZone}</dt>
              <dd>Europe/Rome</dd>
            </div>
            <div>
              <dt>{copy.settings.workerQueue}</dt>
              <dd>{copy.settings.workerQueueStatus(system.jobs.active, system.jobs.failed)}</dd>
            </div>
            <div>
              <dt>{copy.settings.arubaKillSwitchStatus}</dt>
              <dd>
                {system.arubaSubmissionEnabled ? copy.settings.enabled : copy.settings.disabled}
              </dd>
            </div>
          </dl>
        </section>
        <section className="system-group settings-inset-card">
          <h3>{copy.settings.systemData}</h3>
          <dl className="facts">
            <div>
              <dt>{copy.settings.databaseSchema}</dt>
              <dd>{system.schema.latest ?? copy.common.unavailable}</dd>
            </div>
            <div>
              <dt>{copy.settings.lastBackup}</dt>
              <dd>
                {system.backup
                  ? copy.settings.backupStatus(
                      dateTime(system.backup.completedAt),
                      system.backup.sizeBytes,
                    )
                  : copy.settings.backupPending}
              </dd>
            </div>
          </dl>
        </section>
        <section className="system-group settings-inset-card">
          <h3>{copy.settings.systemTechnical}</h3>
          <dl className="facts">
            <div>
              <dt>{copy.settings.applicationVersion}</dt>
              <dd>{system.application.version}</dd>
            </div>
            <div>
              <dt>{copy.settings.commit}</dt>
              <dd>
                <details className="technical-value">
                  <summary>
                    <code>{system.application.commit.slice(0, 18)}</code>
                  </summary>
                  <code>{system.application.commit}</code>
                </details>
              </dd>
            </div>
            <div>
              <dt>{copy.settings.imageDigest}</dt>
              <dd>
                <details className="technical-value">
                  <summary>
                    <code>{system.application.imageDigest.slice(0, 18)}</code>
                  </summary>
                  <code>{system.application.imageDigest}</code>
                </details>
              </dd>
            </div>
          </dl>
        </section>
      </div>
      <p className="field-help">{copy.settings.systemOperationalHelp}</p>
    </section>
  );
}
