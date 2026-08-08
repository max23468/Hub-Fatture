import { randomBytes, randomUUID } from "node:crypto";

import type pg from "pg";

import { AGENT_USERNAME, OWNER_USERNAME } from "./auth.ts";
import { getConfig } from "./config.server.ts";
import { hashPassword, hashToken, safeEqual, verifyPassword } from "./crypto.server.ts";
import { getPool, withTransaction } from "./db/client.server.ts";
import { AppError } from "./errors.ts";

const SESSION_COOKIE = "sessione";
const CSRF_COOKIE = "csrf";
const RATE_LIMIT_WINDOW_MINUTES = 15;
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
}

export interface SessionUser {
  id: number;
  username: string;
  csrfToken: string;
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
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; SameSite=Strict; HttpOnly${secure}`;
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

async function audit(
  client: pg.PoolClient,
  action: string,
  actorId: string | null,
  requestId: string,
  eventClass: "CRITICAL" | "OPERATIONAL" = "OPERATIONAL",
) {
  await client.query(
    `INSERT INTO audit_events
      (actor_type, actor_id, action, event_class, entity_type, entity_id, request_id)
     VALUES ('ADMIN', $1, $2, $3, 'USER', $1, $4)`,
    [actorId, action, eventClass, requestId],
  );
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

  const [ownerHash, agentHash] = await Promise.all([
    hashPassword(input.ownerPassword),
    hashPassword(input.agentPassword),
  ]);

  await withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('hub-fatture-account-setup'))");
    const existing = await client.query<{ count: string }>("SELECT count(*) FROM users");
    if (Number(existing.rows[0]?.count) > 0) throw new AppError("AUTH_SETUP_DISABLED", 409);

    const result = await client.query<{ id: number }>(
      `INSERT INTO users (username, password_hash)
       VALUES ($1, $2), ($3, $4)
       RETURNING id`,
      [OWNER_USERNAME, ownerHash, AGENT_USERNAME, agentHash],
    );
    await client.query(
      `INSERT INTO audit_events
        (actor_type, actor_id, action, event_class, entity_type, entity_id, request_id)
       SELECT 'ADMIN', id::text, 'ADMIN_ACCOUNT_CREATED', 'CRITICAL', 'USER', id::text, $2
       FROM unnest($1::smallint[]) AS created(id)`,
      [result.rows.map((row) => row.id), input.requestId],
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
    await client.query(
      `DELETE FROM login_attempts
       WHERE attempted_at <= now() - interval '${RATE_LIMIT_WINDOW_MINUTES} minutes'`,
    );
    await client.query("DELETE FROM sessions WHERE expires_at <= now()");
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
    // ponytail: il lock serializza per username, non per origine, quindi richieste parallele
    // dallo stesso indirizzo su username diversi possono superare la soglia di poche unità;
    // aggiungere un lock per origine solo se l'eccedenza diventa osservabile.
    const blocked =
      originFailures >= RATE_LIMIT_ORIGIN_ATTEMPTS ||
      usernameFailures >= RATE_LIMIT_USERNAME_ATTEMPTS;

    // Oltre la soglia non si verifica nulla: senza questo, il limite cambierebbe soltanto la
    // risposta e lascerebbe all'attaccante tentativi illimitati.
    if (blocked) {
      await client.query(
        "INSERT INTO login_attempts (username, ip_hash, successful) VALUES ($1, $2, false)",
        [attemptKey, input.ipHash],
      );
      // Una riga per episodio: l'audit resta osservabile senza crescere sotto attacco.
      if (
        originFailures === RATE_LIMIT_ORIGIN_ATTEMPTS ||
        usernameFailures === RATE_LIMIT_USERNAME_ATTEMPTS
      ) {
        await audit(client, "LOGIN_RATE_LIMITED", null, input.requestId, "CRITICAL");
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
      await audit(client, "LOGIN_FAILED", user ? String(user.id) : null, input.requestId);
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
    await audit(client, "LOGIN_SUCCEEDED", String(user.id), input.requestId);
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
  const result = await getPool().query<{ id: number; username: string; csrf_token_hash: string }>(
    `SELECT users.id, users.username, sessions.csrf_token_hash
     FROM sessions JOIN users ON users.id = sessions.user_id
     WHERE sessions.id_hash = $1 AND sessions.expires_at > now()`,
    [hashToken(sessionToken)],
  );
  const row = result.rows[0];
  if (!row || !safeEqual(row.csrf_token_hash, hashToken(csrfToken))) return null;
  await getPool().query("UPDATE sessions SET last_seen_at = now() WHERE id_hash = $1", [
    hashToken(sessionToken),
  ]);
  return { id: row.id, username: row.username, csrfToken };
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
    if (userId) await audit(client, "LOGOUT_SUCCEEDED", String(userId), requestId(request));
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

export function requestId(request: Request): string {
  return request.headers.get("x-request-id") ?? randomUUID();
}
