import type { getArubaApiConnectionStatus } from "../../../src/db/aruba-api-settings.server.ts";
import type { getArubaMonthlyTransmissionUsage } from "../../../src/db/aruba-api-outbound.server.ts";
import { copy } from "../../copy.it";
import { date, dateTime } from "../../format";

type ArubaApiStatus = Awaited<ReturnType<typeof getArubaApiConnectionStatus>>;
type ArubaMonthlyUsage = Awaited<ReturnType<typeof getArubaMonthlyTransmissionUsage>>;
type ArubaAccount = NonNullable<ArubaApiStatus["account"]>;

function accountUsageTone(usagePercent: number) {
  if (usagePercent >= 95) return "critical";
  if (usagePercent >= 80) return "warning";
  return "healthy";
}

function AccountStatus({ expired }: { expired: boolean }) {
  return (
    <span className={`settings-status settings-status--${expired ? "warning" : "success"}`}>
      {expired ? copy.settings.arubaAccountUnavailable : copy.settings.arubaAccountActive}
    </span>
  );
}

function AccountService({ account, usage }: { account: ArubaAccount; usage: ArubaMonthlyUsage }) {
  return (
    <section className="aruba-account-service" aria-labelledby="aruba-service-title">
      <header>
        <h4 id="aruba-service-title">{copy.settings.arubaServiceBlockTitle}</h4>
        <p>{copy.settings.arubaServiceBlockHelp}</p>
      </header>
      <div className="aruba-service-card__grid">
        <div className="aruba-service-card__metric">
          <span>{copy.settings.arubaServiceExpiration}</span>
          <strong>{date(account.accountStatus.expirationDate)}</strong>
          {!account.accountStatus.expired && account.expirationDays <= 30 ? (
            <small className={account.expirationDays <= 7 ? "warning" : undefined} role="status">
              {copy.settings.arubaAccountExpirationWarning(Math.max(account.expirationDays, 0))}
            </small>
          ) : null}
        </div>
        <div
          className={`aruba-service-card__metric aruba-service-card__metric--${accountUsageTone(account.usagePercent)}`}
        >
          <span>{copy.settings.arubaServiceSpaceUsed}</span>
          <strong>{copy.settings.arubaAccountStorageValue(account.usagePercent)}</strong>
          <progress
            aria-label={copy.settings.arubaAccountStorage}
            max={100}
            value={Math.min(account.usagePercent, 100)}
          >
            {account.usagePercent}%
          </progress>
          <small>
            {copy.settings.arubaServiceSpaceValue(
              account.usageStatus.usedSpaceKB,
              account.usageStatus.maxSpaceKB,
            )}
          </small>
        </div>
        <div className="aruba-service-card__metric">
          <span>{copy.settings.arubaMonthlyUsageTitle}</span>
          <strong>{copy.settings.arubaMonthlyUsage(usage.accepted)}</strong>
          {usage.warning ? (
            <small className="warning" role="status">
              {copy.settings.arubaMonthlyWarning(usage.warning, usage.remaining)}
            </small>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function AccountDetails({ account, usage }: { account: ArubaAccount; usage: ArubaMonthlyUsage }) {
  return (
    <>
      <strong className="aruba-account-card__name">{account.userDescription}</strong>
      <details className="settings-disclosure aruba-account-details">
        <summary>{copy.settings.arubaAccountDetails}</summary>
        <div className="aruba-account-details__content">
          <dl className="aruba-account-card__facts">
            <div>
              <dt>{copy.settings.arubaAccountUsername}</dt>
              <dd>{account.username}</dd>
            </div>
            <div>
              <dt>{copy.settings.arubaAccountPec}</dt>
              <dd>{account.pec}</dd>
            </div>
            <div>
              <dt>{copy.settings.arubaAccountCountry}</dt>
              <dd>{account.countryCode}</dd>
            </div>
            <div>
              <dt>{copy.settings.arubaAccountVat}</dt>
              <dd>{account.vatCode}</dd>
            </div>
            <div>
              <dt>{copy.settings.arubaAccountFiscalCode}</dt>
              <dd>{account.fiscalCode}</dd>
            </div>
          </dl>
          <small className="aruba-section-card__updated">
            {copy.settings.arubaAccountCheckedAt(
              account.checkedAt ? dateTime(account.checkedAt) : copy.settings.never,
            )}
          </small>
          <AccountService account={account} usage={usage} />
        </div>
      </details>
    </>
  );
}

export function ArubaAccountCard({
  api,
  usage,
}: {
  api: ArubaApiStatus;
  usage: ArubaMonthlyUsage;
}) {
  const account = api.account;
  return (
    <section
      className="aruba-account-card"
      id="aruba-account"
      aria-labelledby="aruba-account-title"
    >
      <header className="aruba-section-card__header">
        <div>
          <h3 id="aruba-account-title">{copy.settings.arubaAccountBlockTitle}</h3>
        </div>
        {account ? <AccountStatus expired={account.accountStatus.expired} /> : null}
      </header>
      {account ? (
        <AccountDetails account={account} usage={usage} />
      ) : (
        <p className="aruba-section-card__empty">{copy.settings.arubaAccountUnavailableHelp}</p>
      )}
    </section>
  );
}
