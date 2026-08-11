import { randomBytes, randomUUID } from "node:crypto";
import { redirect } from "react-router";

import { writeAudit } from "./audit.server.ts";
import { AGENT_USERNAME, OWNER_USERNAME } from "../auth.ts";
import { getConfig } from "../config.server.ts";
import { hashPassword, hashToken, safeEqual, verifyPassword } from "../crypto.server.ts";
import { getPool, withTransaction } from "./client.server.ts";
import { AppError } from "../errors.ts";
import { LOGIN_ATTEMPT_WINDOW_MINUTES as RATE_LIMIT_WINDOW_MINUTES } from "./retention.server.ts";

const SESSION_COOKIE = "sessione";
const CSRF_COOKIE = "csrf";
// La soglia stretta vale per origine: un attaccante blocca sé stesso, non il titolare, che
// arriva da un altro indirizzo. Quella per username resta come argine agli attacchi
// distribuiti, dove il blocco del titolare è un incidente e non un fastidio quotidiano.
const RATE_LIMIT_ORIGIN_ATTEMPTS = 5;
const RATE_LIMIT_USERNAME_ATTEMPTS = 50;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;

let dummyPasswordHash: Promise<string> | undefined;

function absentUserHash(): Promise<string> {
  return (dummyPasswordHash ??= hashPassword(randomBytes(32).toString("base64url")));
}

interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  can_approve: boolean;
}

export interface SessionUser {
  id: number;
  username: string;
  csrfToken: string;
  canApprove: boolean;
}

export interface AccountSession {
  current: boolean;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
}

function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

function validPassword(value: string): boolean {
  return value.length >= MIN_PASSWORD_LENGTH && value.length <= MAX_PASSWORD_LENGTH;
}

// Nessun codice client legge questi cookie: il server rilegge il CSRF e lo stampa nel form.
function cookie(name: string, value: string, maxAge: number): string {
  const secure = getConfig().APP_ENV === "production" ? "; Secure" : "";
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; SameSite=Lax; HttpOnly${secure}`;
}

function cookies(request: Request): Map<string, string> {
  return new Map(
    (request.headers.get("cookie") ?? "")
      .split(";")
      .map((part) => part.trim().split("="))
      .filter(([name, value]) => name && value)
      .map(([name, value]) => {
        try {
          return [name!, decodeURIComponent(value!)] as const;
        } catch {
          return [name!, ""] as const;
        }
      }),
  );
}

function currentSessionHash(request: Request): string | null {
  const sessionToken = cookies(request).get(SESSION_COOKIE);
  return sessionToken ? hashToken(sessionToken) : null;
}

export async function setupAvailable(): Promise<boolean> {
  const result = await getPool().query<{ count: string }>("SELECT count(*) FROM users");
  return Number(result.rows[0]?.count) === 0;
}

export async function setupAccounts(input: {
  bootstrapToken: string;
  ownerPassword: string;
  agentPassword: string;
  requestId: string;
}) {
  if (!safeEqual(input.bootstrapToken, getConfig().ADMIN_BOOTSTRAP_TOKEN)) {
    throw new AppError("AUTH_INVALID_SETUP_TOKEN", 403);
  }
  if (!validPassword(input.ownerPassword) || !validPassword(input.agentPassword)) {
    throw new AppError("AUTH_PASSWORD_POLICY", 400);
  }
  if (!(await setupAvailable())) throw new AppError("AUTH_SETUP_DISABLED", 409);

  const [ownerHash, agentHash] = await Promise.all([
    hashPassword(input.ownerPassword),
    hashPassword(input.agentPassword),
  ]);

  await withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('hub-fatture-account-setup'))");
    const existing = await client.query<{ count: string }>("SELECT count(*) FROM users");
    if (Number(existing.rows[0]?.count) > 0) throw new AppError("AUTH_SETUP_DISABLED", 409);

    const result = await client.query<{ id: number }>(
      `INSERT INTO users (username, password_hash, can_approve)
       VALUES ($1, $2, true), ($3, $4, false)
       RETURNING id`,
      [OWNER_USERNAME, ownerHash, AGENT_USERNAME, agentHash],
    );
    await Promise.all(
      result.rows.map((row) =>
        writeAudit(client, {
          actorType: "ADMIN",
          actorId: String(row.id),
          action: "ADMIN_ACCOUNT_CREATED",
          eventClass: "CRITICAL",
          entityType: "USER",
          entityId: String(row.id),
          requestId: input.requestId,
        }),
      ),
    );
  });
}

export async function login(input: {
  username: string;
  password: string;
  ipHash: string;
  requestId: string;
}) {
  const username = normalizeUsername(input.username);
  const attemptKey =
    username === OWNER_USERNAME || username === AGENT_USERNAME ? username : "__unknown__";
  if (username.length > 64 || input.password.length > MAX_PASSWORD_LENGTH) {
    throw new AppError("AUTH_INVALID_CREDENTIALS", 401);
  }
  const result = await withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`login:${attemptKey}`]);
    const recent = await client.query<{ origin_failures: string; username_failures: string }>(
      `SELECT count(*) FILTER (WHERE ip_hash = $2) AS origin_failures,
              count(*) FILTER (WHERE username = $1) AS username_failures
       FROM login_attempts
       WHERE successful = false
         AND attempted_at > now() - interval '${RATE_LIMIT_WINDOW_MINUTES} minutes'
         AND (ip_hash = $2 OR username = $1)`,
      [attemptKey, input.ipHash],
    );
    const originFailures = Number(recent.rows[0]?.origin_failures);
    const usernameFailures = Number(recent.rows[0]?.username_failures);
    const blocked =
      originFailures >= RATE_LIMIT_ORIGIN_ATTEMPTS ||
      usernameFailures >= RATE_LIMIT_USERNAME_ATTEMPTS;

    // Oltre la soglia non si verifica nulla: senza questo, il limite cambierebbe soltanto la
    // risposta e lascerebbe all'attaccante tentativi illimitati.
    if (blocked) {
      // Il percorso bloccato non scrive: accodare ogni richiesta respinta farebbe crescere
      // tabella e indici sotto flood, rendendo il limite stesso una leva sul database.
      // La finestra resta quindi fissa e decorre dal tentativo che ha raggiunto la soglia.
      const scope =
        originFailures >= RATE_LIMIT_ORIGIN_ATTEMPTS ? input.ipHash : `username:${attemptKey}`;
      // Il lock per username non copre due richieste parallele sulla stessa origine: senza
      // questo secondo lock la coppia SELECT/INSERT eviterebbe l'evento mancante ma non i
      // duplicati. L'ordine username poi scope è lo stesso ovunque, quindi non genera cicli.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`rate-limit:${scope}`]);
      const registered = await client.query(
        `SELECT 1 FROM audit_events
         WHERE action = 'LOGIN_RATE_LIMITED' AND metadata_json->>'scope' = $1
           AND created_at > now() - interval '${RATE_LIMIT_WINDOW_MINUTES} minutes'
         LIMIT 1`,
        [scope],
      );
      if (registered.rowCount === 0) {
        await writeAudit(client, {
          actorType: "ADMIN",
          action: "LOGIN_RATE_LIMITED",
          eventClass: "CRITICAL",
          entityType: "USER",
          metadata: { scope },
          requestId: input.requestId,
        });
      }
      return { error: new AppError("AUTH_RATE_LIMITED", 429) } as const;
    }

    const users = await client.query<UserRow>("SELECT * FROM users WHERE username = $1", [
      username,
    ]);
    const user = users.rows[0];
    const passwordValid = await verifyPassword(
      input.password,
      user?.password_hash ?? (await absentUserHash()),
    );

    if (!user || !passwordValid) {
      await client.query(
        "INSERT INTO login_attempts (username, ip_hash, successful) VALUES ($1, $2, false)",
        [attemptKey, input.ipHash],
      );
      await writeAudit(client, {
        actorType: "ADMIN",
        actorId: user ? String(user.id) : null,
        action: "LOGIN_FAILED",
        eventClass: "OPERATIONAL",
        entityType: "USER",
        entityId: user ? String(user.id) : null,
        requestId: input.requestId,
      });
      return { error: new AppError("AUTH_INVALID_CREDENTIALS", 401) } as const;
    }

    const sessionToken = randomBytes(32).toString("base64url");
    const csrfToken = randomBytes(32).toString("base64url");
    const ttl = getConfig().SESSION_TTL_SECONDS;
    await client.query(
      `INSERT INTO sessions (id_hash, user_id, csrf_token_hash, expires_at)
       VALUES ($1, $2, $3, now() + ($4 * interval '1 second'))`,
      [hashToken(sessionToken), user.id, hashToken(csrfToken), ttl],
    );
    await client.query("UPDATE users SET last_login_at = now() WHERE id = $1", [user.id]);
    // Solo la coppia che ha appena avuto successo: un accesso legittimo del titolare non deve
    // azzerare il contatore di un attaccante che stava provando lo stesso username da altrove.
    await client.query(
      "DELETE FROM login_attempts WHERE username = $1 AND ip_hash = $2 AND successful = false",
      [username, input.ipHash],
    );
    await client.query(
      "INSERT INTO login_attempts (username, ip_hash, successful) VALUES ($1, $2, true)",
      [username, input.ipHash],
    );
    await writeAudit(client, {
      actorType: "ADMIN",
      actorId: String(user.id),
      action: "LOGIN_SUCCEEDED",
      eventClass: "OPERATIONAL",
      entityType: "USER",
      entityId: String(user.id),
      requestId: input.requestId,
    });
    return {
      cookies: [cookie(SESSION_COOKIE, sessionToken, ttl), cookie(CSRF_COOKIE, csrfToken, ttl)],
    } as const;
  });

  if ("error" in result) throw result.error;
  return result.cookies;
}

export async function getSessionUser(request: Request): Promise<SessionUser | null> {
  const values = cookies(request);
  const sessionToken = values.get(SESSION_COOKIE);
  const csrfToken = values.get(CSRF_COOKIE);
  if (!sessionToken || !csrfToken) return null;
  const result = await getPool().query<{
    id: number;
    username: string;
    can_approve: boolean;
    csrf_token_hash: string;
  }>(
    `SELECT users.id, users.username, users.can_approve, sessions.csrf_token_hash
     FROM sessions JOIN users ON users.id = sessions.user_id
     WHERE sessions.id_hash = $1 AND sessions.expires_at > now()`,
    [hashToken(sessionToken)],
  );
  const row = result.rows[0];
  if (!row || !safeEqual(row.csrf_token_hash, hashToken(csrfToken))) return null;
  await getPool().query("UPDATE sessions SET last_seen_at = now() WHERE id_hash = $1", [
    hashToken(sessionToken),
  ]);
  return { id: row.id, username: row.username, csrfToken, canApprove: row.can_approve };
}

export async function requireSessionUser(request: Request): Promise<SessionUser> {
  const user = await getSessionUser(request);
  if (!user) throw redirect("/login");
  return user;
}

export async function getAccountProfile(request: Request, user: SessionUser) {
  const sessionHash = currentSessionHash(request);
  if (!sessionHash) throw new AppError("AUTH_INVALID_CREDENTIALS", 401);
  const [account, sessions] = await Promise.all([
    getPool().query<{ created_at: Date; last_login_at: Date | null }>(
      "SELECT created_at, last_login_at FROM users WHERE id = $1",
      [user.id],
    ),
    getPool().query<{
      id_hash: string;
      created_at: Date;
      last_seen_at: Date;
      expires_at: Date;
    }>(
      `SELECT id_hash, created_at, last_seen_at, expires_at FROM sessions
       WHERE user_id = $1 AND expires_at > now()
       ORDER BY last_seen_at DESC`,
      [user.id],
    ),
  ]);
  return {
    createdAt: account.rows[0]!.created_at.toISOString(),
    lastLoginAt: account.rows[0]!.last_login_at?.toISOString() ?? null,
    sessions: sessions.rows.map((row): AccountSession => ({
      current: row.id_hash === sessionHash,
      createdAt: row.created_at.toISOString(),
      lastSeenAt: row.last_seen_at.toISOString(),
      expiresAt: row.expires_at.toISOString(),
    })),
  };
}

export async function changePassword(
  request: Request,
  input: { currentPassword: unknown; newPassword: unknown; confirmation: unknown },
  user: SessionUser,
  auditRequestId: string,
) {
  const currentPassword = typeof input.currentPassword === "string" ? input.currentPassword : "";
  const newPassword = typeof input.newPassword === "string" ? input.newPassword : "";
  const confirmation = typeof input.confirmation === "string" ? input.confirmation : "";
  const sessionHash = currentSessionHash(request);
  if (!sessionHash) throw new AppError("AUTH_INVALID_CREDENTIALS", 401);
  if (!validPassword(newPassword)) throw new AppError("AUTH_PASSWORD_POLICY", 400);
  if (newPassword !== confirmation) throw new AppError("AUTH_PASSWORD_CONFIRMATION", 400);

  const account = await getPool().query<{ password_hash: string }>(
    "SELECT password_hash FROM users WHERE id = $1",
    [user.id],
  );
  const currentHash = account.rows[0]?.password_hash;
  if (!currentHash || !(await verifyPassword(currentPassword, currentHash))) {
    throw new AppError("AUTH_CURRENT_PASSWORD_INVALID", 403);
  }
  if (await verifyPassword(newPassword, currentHash)) {
    throw new AppError("AUTH_PASSWORD_REUSE", 400);
  }
  const nextHash = await hashPassword(newPassword);
  return withTransaction(async (client) => {
    const updated = await client.query(
      "UPDATE users SET password_hash = $1 WHERE id = $2 AND password_hash = $3",
      [nextHash, user.id, currentHash],
    );
    if (updated.rowCount !== 1) throw new AppError("CONFLICT_REVISION", 409);
    const revoked = await client.query(
      "DELETE FROM sessions WHERE user_id = $1 AND id_hash <> $2",
      [user.id, sessionHash],
    );
    await writeAudit(client, {
      actorType: "ADMIN",
      actorId: String(user.id),
      action: "ACCOUNT_PASSWORD_CHANGED",
      eventClass: "CRITICAL",
      entityType: "USER",
      entityId: String(user.id),
      requestId: auditRequestId,
    });
    return revoked.rowCount ?? 0;
  });
}

export async function revokeOtherSessions(
  request: Request,
  user: SessionUser,
  auditRequestId: string,
) {
  const sessionHash = currentSessionHash(request);
  if (!sessionHash) throw new AppError("AUTH_INVALID_CREDENTIALS", 401);
  return withTransaction(async (client) => {
    const revoked = await client.query(
      "DELETE FROM sessions WHERE user_id = $1 AND id_hash <> $2",
      [user.id, sessionHash],
    );
    if (revoked.rowCount) {
      await writeAudit(client, {
        actorType: "ADMIN",
        actorId: String(user.id),
        action: "ACCOUNT_SESSIONS_REVOKED",
        eventClass: "OPERATIONAL",
        entityType: "USER",
        entityId: String(user.id),
        requestId: auditRequestId,
      });
    }
    return revoked.rowCount ?? 0;
  });
}

export function assertCsrf(user: SessionUser, submitted: string): void {
  if (!safeEqual(user.csrfToken, submitted)) {
    throw new AppError("REQUEST_ORIGIN_INVALID", 403);
  }
}

export async function logout(request: Request, submittedCsrf: string) {
  const values = cookies(request);
  const sessionToken = values.get(SESSION_COOKIE);
  const csrfToken = values.get(CSRF_COOKIE);
  // Uscire senza sessione è già il risultato voluto: la pagina scaduta ripulisce i cookie e prosegue.
  if (!sessionToken || !csrfToken) return;
  if (!safeEqual(csrfToken, submittedCsrf)) throw new AppError("AUTH_INVALID_CREDENTIALS", 403);
  await withTransaction(async (client) => {
    const result = await client.query<{ user_id: number }>(
      `DELETE FROM sessions
       WHERE id_hash = $1 AND csrf_token_hash = $2
       RETURNING user_id`,
      [hashToken(sessionToken), hashToken(csrfToken)],
    );
    const userId = result.rows[0]?.user_id;
    if (userId) {
      await writeAudit(client, {
        actorType: "ADMIN",
        actorId: String(userId),
        action: "LOGOUT_SUCCEEDED",
        eventClass: "OPERATIONAL",
        entityType: "USER",
        entityId: String(userId),
        requestId: requestId(request),
      });
    }
  });
}

export function clearSessionCookies(): string[] {
  return [cookie(SESSION_COOKIE, "", 0), cookie(CSRF_COOKIE, "", 0)];
}

/**
 * Caddy è l'unico ingresso e accoda l'indirizzo che vede davvero in fondo a `X-Forwarded-For`:
 * l'ultimo valore è l'unico non falsificabile dal client. In accesso diretto, senza proxy,
 * tutte le richieste condividono un solo secchio.
 * L'hash resta al massimo quanto la finestra: la potatura di ogni login lo rimuove.
 */
export function clientIpHash(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim();
  return hashToken(forwarded || "__diretto__");
}

export function requestId(_request: Request): string {
  return randomUUID();
}
