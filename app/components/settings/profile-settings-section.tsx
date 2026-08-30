import { CircleUserRound, LogOut, ShieldCheck } from "lucide-react";
import { Form } from "react-router";

import type { getAccountProfile } from "../../../src/db/auth.server.ts";
import { copy } from "../../copy.it";
import { dateTime } from "../../format";
import { SettingsSectionHeader } from "../settings-controls";
import { ThemePicker } from "../theme-picker";
import type { ErrorFor } from "./settings-types";

export function ProfileSettingsSection({
  username,
  canApprove,
  csrfToken,
  profile,
  passwordChanged,
  sessionsRevoked,
  errorFor,
}: {
  username: string;
  canApprove: boolean;
  csrfToken: string;
  profile: Awaited<ReturnType<typeof getAccountProfile>>;
  passwordChanged: boolean;
  sessionsRevoked: boolean;
  errorFor: ErrorFor;
}) {
  const otherSessions = profile.sessions.filter((session) => !session.current);
  return (
    <section
      className="settings-section"
      id="profilo-sicurezza"
      aria-labelledby="profilo-sicurezza-title"
    >
      <SettingsSectionHeader
        id="profilo-sicurezza"
        icon={CircleUserRound}
        title={copy.settings.profileTitle}
        intro={copy.settings.profileHelp}
      />
      {passwordChanged ? (
        <p className="notice" role="status">
          {copy.settings.passwordChanged}
        </p>
      ) : null}
      {sessionsRevoked ? (
        <p className="notice" role="status">
          {copy.settings.sessionsRevoked}
        </p>
      ) : null}
      <div className="settings-profile-grid">
        <div className="profile-overview settings-inset-card">
          <span className="profile-overview__avatar" aria-hidden="true">
            <CircleUserRound size={30} strokeWidth={1.6} />
          </span>
          <div className="profile-overview__identity">
            <strong>{username}</strong>
            <span>{canApprove ? copy.navigation.ownerRole : copy.navigation.operatorRole}</span>
          </div>
          <p className="profile-overview__permission">
            <ShieldCheck aria-hidden="true" size={18} strokeWidth={1.8} />
            {canApprove ? copy.navigation.ownerPermission : copy.navigation.operatorPermission}
          </p>
        </div>
        <div className="settings-inset-card settings-appearance-card">
          <h3>{copy.settings.appearanceTitle}</h3>
          <ThemePicker />
        </div>
      </div>
      <div className="settings-profile-details">
        <div className="settings-inset-card settings-detail-card">
          <header className="settings-detail-card__header">
            <h3>{copy.settings.passwordTitle}</h3>
            <p>{copy.settings.passwordHelp}</p>
          </header>
          <Form method="post" className="security-form">
            <input type="hidden" name="csrf" value={csrfToken} />
            <input type="hidden" name="intent" value="change-password" />
            <input
              aria-label={copy.login.username}
              autoComplete="username"
              className="visually-hidden"
              name="username"
              readOnly
              tabIndex={-1}
              type="text"
              value={username}
            />
            <label>
              {copy.settings.currentPassword}
              <input
                autoComplete="current-password"
                maxLength={128}
                name="currentPassword"
                required
                type="password"
              />
            </label>
            <label>
              {copy.settings.newPassword}
              <input
                autoComplete="new-password"
                minLength={8}
                maxLength={128}
                name="newPassword"
                required
                type="password"
              />
            </label>
            <label className="security-form__confirmation">
              {copy.settings.passwordConfirmation}
              <input
                autoComplete="new-password"
                minLength={8}
                maxLength={128}
                name="passwordConfirmation"
                required
                type="password"
              />
            </label>
            {errorFor("change-password") ? (
              <p className="error" role="alert">
                {errorFor("change-password")}
              </p>
            ) : null}
            <button className="button" type="submit">
              {copy.settings.changePassword}
            </button>
          </Form>
          <div className="settings-password-exit">
            <div>
              <h4>{copy.settings.exitTitle}</h4>
              <p>{copy.settings.exitHelp}</p>
            </div>
            <Form method="post" action="/logout">
              <input type="hidden" name="csrf" value={csrfToken} />
              <button className="button button--secondary" type="submit">
                <LogOut aria-hidden="true" size={17} strokeWidth={1.8} />
                {copy.navigation.logout}
              </button>
            </Form>
          </div>
        </div>

        <div className="settings-inset-card settings-detail-card settings-sessions-card">
          <header className="settings-detail-card__header">
            <h3>{copy.settings.sessionsTitle}</h3>
            <p>{copy.settings.sessionsHelp}</p>
          </header>
          <ul className="session-list">
            {profile.sessions.map((session) => (
              <li key={`${session.createdAt}:${session.expiresAt}:${session.current}`}>
                <span>
                  <strong>
                    {session.current ? copy.settings.currentSession : copy.settings.otherSession}
                  </strong>
                  <small>{copy.settings.lastActivity(dateTime(session.lastSeenAt))}</small>
                </span>
                <small>{copy.settings.sessionExpiry(dateTime(session.expiresAt))}</small>
              </li>
            ))}
          </ul>
          {otherSessions.length ? (
            <Form method="post" className="settings-card-action">
              <input type="hidden" name="csrf" value={csrfToken} />
              <input type="hidden" name="intent" value="revoke-other-sessions" />
              {errorFor("revoke-other-sessions") ? (
                <p className="error" role="alert">
                  {errorFor("revoke-other-sessions")}
                </p>
              ) : null}
              <button className="button button--secondary" type="submit">
                {copy.settings.revokeOtherSessions}
              </button>
            </Form>
          ) : (
            <p className="field-help settings-card-action">{copy.settings.noOtherSessions}</p>
          )}
        </div>
      </div>
    </section>
  );
}
