/**
 * Atlas Sync — Cloudflare Worker + SQLite-backed Durable Object.
 *
 * Runtime uses Web APIs only (no Node built-ins). The Worker answers health and
 * CORS preflight directly and forwards every other /api/* request to one global
 * Durable Object named "atlas-sync-global". That object owns all SQLite state,
 * all rate-limit counters, and all in-memory SSE subscriber streams.
 *
 * API contract is compatible with the original atlas-sync/server.js:
 *   - Authorization: Bearer <token> for every authenticated call
 *   - native EventSource on GET /api/events?token=<token>
 *   - CORS: allow all origins, OPTIONS -> 204
 * New additions: unified profiles, profile gating, and calendar APIs.
 */

const TEXT = new TextEncoder();

const APPS = ['meridian', 'airo', 'tandem', 'business', 'developer'];
const APP_SET = new Set(APPS);
const PROFILE_TYPES = ['personal', 'family', 'business', 'developer'];
const PROFILE_SET = new Set(PROFILE_TYPES);
const CALENDAR_APP = 'calendar';
const EVENT_APPS = [...APPS, CALENDAR_APP];
const EVENT_APP_SET = new Set(EVENT_APPS);

// Which profile type an app-derived snapshot/stream is associated with.
const APP_PROFILE_PREFERENCE = {
  meridian: ['personal', 'family'],
  airo: ['personal', 'family'],
  tandem: ['family', 'personal'],
  business: ['business'],
  developer: ['developer'],
};

// Endpoints that must reject personal/family tokens.
const APP_REQUIRED_PROFILE = {
  business: ['business'],
  developer: ['developer'],
};

// Defensive derivation rules for GET /api/calendar/derived.
const DERIVED_SPECS = {
  airo: [
    { keys: ['recurringBills', 'bills', 'recurring'], collection: 'bills', dateKeys: ['nextDate', 'dueDate', 'date'], titleKeys: ['name', 'title', 'label'] },
    { keys: ['goals'], collection: 'goals', dateKeys: ['deadline', 'targetDate', 'date'], titleKeys: ['name', 'title'] },
    { keys: ['invoices', 'dueItems'], collection: 'invoices', dateKeys: ['dueDate', 'due', 'date'], titleKeys: ['title', 'name', 'invoiceNumber'] },
  ],
  business: [
    { keys: ['payrollRuns', 'payrolls'], collection: 'payroll', dateKeys: ['payDate', 'date', 'runDate'], titleKeys: ['name', 'title', 'period'] },
    { keys: ['invoices'], collection: 'invoices', dateKeys: ['dueDate', 'due', 'date'], titleKeys: ['title', 'name', 'invoiceNumber'] },
    { keys: ['debts'], collection: 'debts', dateKeys: ['dueDate', 'due', 'date'], titleKeys: ['name', 'title'] },
    { keys: ['employees'], collection: 'reviews', dateKeys: ['reviewDate', 'nextReview', 'review'], titleKeys: ['name', 'title'] },
  ],
  meridian: [
    { keys: ['goals'], collection: 'goals', dateKeys: ['deadline', 'targetDate', 'date'], titleKeys: ['name', 'title'] },
  ],
  tandem: [
    { keys: ['expenses'], collection: 'expenses', dateKeys: ['date', 'dueDate'], titleKeys: ['title', 'name', 'description'] },
  ],
  developer: [
    { keys: ['invoices'], collection: 'invoices', dateKeys: ['dueDate', 'due', 'date'], titleKeys: ['title', 'name', 'invoiceNumber'] },
    { keys: ['subscriptions'], collection: 'subscriptions', dateKeys: ['nextDate', 'renewalDate', 'date'], titleKeys: ['name', 'title'] },
    { keys: ['payouts'], collection: 'payouts', dateKeys: ['date', 'payoutDate'], titleKeys: ['title', 'name'] },
    { keys: ['goals'], collection: 'goals', dateKeys: ['deadline', 'targetDate', 'date'], titleKeys: ['name', 'title'] },
  ],
};
const DERIVED_CAP = 25;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Cloudflare Workers cap WebCrypto PBKDF2 at 100,000 iterations.
const PBKDF2_ITERATIONS = 100000;
const KEY_BYTES = 32;
const SALT_BYTES = 16;
const CODE_TTL_MS = 10 * 60 * 1000;
const SSE_PING_MS = 20 * 1000;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT_MAX = 10;
const MAX_BODY_BYTES = 1024 * 1024;
const GLOBAL_DO_NAME = 'atlas-sync-global';

// Used for unknown emails so login timing does not reveal account existence.
const DUMMY_SALT = '00'.repeat(SALT_BYTES);
const DUMMY_HASH = '00'.repeat(KEY_BYTES);

// ---------------------------------------------------------------------------
// Errors and HTTP helpers
// ---------------------------------------------------------------------------

class ApiError extends Error {
  constructor(status, message, { extra = {}, headers = {} } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.extra = extra;
    this.headers = headers;
  }
}

function fail(status, message, options) {
  throw new ApiError(status, message, options);
}

function corsHeaders(extra = {}) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Expose-Headers': 'Retry-After',
    'Access-Control-Max-Age': '86400',
    ...extra,
  };
}

function jsonResponse(status, payload, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: corsHeaders({ 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders }),
  });
}

function noContent() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

async function readJson(request) {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) fail(413, 'Request body too large');
  if (!text) return {};
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    return value;
  } catch {
    fail(400, 'Invalid JSON body');
  }
}

function clientIp(request) {
  const cf = request.headers.get('cf-connecting-ip');
  if (cf) return cf.trim();
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Web Crypto helpers
// ---------------------------------------------------------------------------

function toHex(bytes) {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function randomBytes(length) {
  return crypto.getRandomValues(new Uint8Array(length));
}

function randomInt(max) {
  if (!Number.isInteger(max) || max <= 0) return 0;
  const ceiling = Math.floor(0x100000000 / max) * max;
  let value = 0;
  do {
    value = crypto.getRandomValues(new Uint32Array(1))[0];
  } while (value >= ceiling);
  return value % max;
}

async function deriveKey(secret, saltHex) {
  const key = await crypto.subtle.importKey('raw', TEXT.encode(secret), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: fromHex(saltHex), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    key,
    256,
  );
  return toHex(bits);
}

async function hashSecret(secret) {
  const salt = toHex(randomBytes(SALT_BYTES));
  const hash = await deriveKey(secret, salt);
  return { salt, hash };
}

function timingSafeHexEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function verifySecret(secret, salt, expectedHash) {
  if (typeof salt !== 'string' || typeof expectedHash !== 'string') return false;
  if (!/^[0-9a-f]{32}$/i.test(salt) || !/^[0-9a-f]{64}$/i.test(expectedHash)) return false;
  const actual = await deriveKey(secret, salt);
  return timingSafeHexEqual(actual, expectedHash.toLowerCase());
}

/** Digest used for pairing codes: HMAC(pepper, code) when set, else SHA-256(code). */
async function codeDigest(code, pepper) {
  if (typeof pepper === 'string' && pepper) {
    const key = await crypto.subtle.importKey(
      'raw', TEXT.encode(pepper), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    );
    return toHex(await crypto.subtle.sign('HMAC', key, TEXT.encode(code)));
  }
  return toHex(await crypto.subtle.digest('SHA-256', TEXT.encode(code)));
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function normalizeProfileType(value, fallback = null) {
  if (typeof value !== 'string') return fallback;
  const type = value.trim().toLowerCase();
  return PROFILE_SET.has(type) ? type : fallback;
}

function publicUser(user, type) {
  // Deliberately whitelist fields: salt/hash are never returned.
  return { id: user.id, email: user.email, name: user.name, type: type ?? null };
}

function publicProfile(profile) {
  return {
    id: profile.id,
    type: profile.type,
    name: profile.name,
    status: profile.status ?? 'active',
  };
}

function publicEvent(row) {
  return {
    id: row.id ?? null,
    profileId: row.profile_id ?? null,
    type: row.profile_type ?? null,
    app: row.app ?? null,
    sourceId: row.source_id ?? null,
    title: row.title ?? '',
    description: row.description ?? '',
    start: row.start_at ?? null,
    end: row.end_at ?? null,
    allDay: Boolean(row.all_day),
    location: row.location ?? '',
    category: row.category ?? '',
    status: row.status ?? 'confirmed',
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

function parseEventDate(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const raw = value.trim();
  const time = Date.parse(raw);
  if (!Number.isFinite(time)) return null;
  const allDay = /^\d{4}-\d{2}-\d{2}$/.test(raw);
  return { value: allDay ? raw : new Date(time).toISOString(), allDay };
}

function safeString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function firstString(object, keys) {
  for (const key of keys) {
    const value = object?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

function arrayFrom(object, keys) {
  for (const key of keys) {
    if (Array.isArray(object?.[key])) return object[key];
  }
  return [];
}

function safeParse(text) {
  if (typeof text !== 'string') return null;
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object') return null;
    return value;
  } catch {
    return null;
  }
}

function humanize(value) {
  return String(value).replace(/[^a-z0-9]+/gi, ' ').trim().replace(/^./, (char) => char.toUpperCase()) || 'Event';
}

function decodeSegment(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    fail(400, 'Invalid path parameter');
  }
}

function validateEventApp(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  const candidate = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!EVENT_APP_SET.has(candidate)) {
    fail(400, `Invalid app "${String(value)}". Allowed apps: ${EVENT_APPS.join(', ')}`);
  }
  return candidate;
}

// ---------------------------------------------------------------------------
// In-memory rate limiting (per Durable Object instance)
// ---------------------------------------------------------------------------

class RateLimiter {
  constructor() {
    this.hits = new Map();
  }

  check(key, max = RATE_LIMIT_MAX, windowMs = RATE_LIMIT_WINDOW_MS) {
    const now = Date.now();
    const recent = (this.hits.get(key) || []).filter((time) => now - time < windowMs);
    if (recent.length >= max) {
      this.hits.set(key, recent);
      return { allowed: false, retryAfterMs: windowMs - (now - recent[0]) };
    }
    recent.push(now);
    this.hits.set(key, recent);
    return { allowed: true };
  }
}

// ---------------------------------------------------------------------------
// Durable Object
// ---------------------------------------------------------------------------

export class AtlasSyncDO {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.limiter = new RateLimiter();
    // userId -> Set<{ controller, cleanup }>. Held in memory on this object.
    this.sseClients = new Map();
    this.schemaReady = false;
  }

  get sql() {
    return this.ctx.storage.sql;
  }

  query(statement, ...params) {
    return Array.from(this.sql.exec(statement, ...params));
  }

  one(statement, ...params) {
    return this.query(statement, ...params)[0] ?? null;
  }

  ensureSchema() {
    if (this.schemaReady) return;
    const sql = this.sql;
    sql.exec('CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE, name TEXT, salt TEXT, hash TEXT, created_at TEXT)');
    sql.exec('CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY, user_id TEXT, type TEXT, name TEXT, status TEXT, created_at TEXT)');
    sql.exec('CREATE UNIQUE INDEX IF NOT EXISTS profiles_user_type ON profiles(user_id, type)');
    sql.exec('CREATE TABLE IF NOT EXISTS tokens (token TEXT PRIMARY KEY, user_id TEXT, profile_id TEXT, created_at TEXT)');
    // Legacy v1 deployments created tokens before profile_id existed.
    try {
      sql.exec('ALTER TABLE tokens ADD COLUMN profile_id TEXT');
    } catch {
      // Column already present: nothing to migrate.
    }
    sql.exec('CREATE TABLE IF NOT EXISTS connector_codes (code_hash TEXT PRIMARY KEY, user_id TEXT, expires_at TEXT, used INTEGER DEFAULT 0, created_at TEXT)');
    sql.exec('CREATE TABLE IF NOT EXISTS snapshots (user_id TEXT, app TEXT, data TEXT, updated_at TEXT, PRIMARY KEY(user_id, app))');
    sql.exec('CREATE TABLE IF NOT EXISTS calendar_events (id TEXT PRIMARY KEY, user_id TEXT, profile_id TEXT, app TEXT, source_id TEXT, title TEXT, description TEXT, start_at TEXT, end_at TEXT, all_day INTEGER, location TEXT, category TEXT, status TEXT, created_at TEXT, updated_at TEXT, UNIQUE(user_id, source_id))');
    this.schemaReady = true;
  }

  async fetch(request) {
    this.ensureSchema();
    try {
      return await this.route(request);
    } catch (err) {
      if (err instanceof ApiError) {
        return jsonResponse(err.status, { error: err.message, ...err.extra }, err.headers);
      }
      console.error('atlas-sync-worker: unexpected error:', err);
      return jsonResponse(500, { error: 'Internal server error' });
    }
  }

  async route(request) {
    if (request.method === 'OPTIONS') return noContent();

    const url = new URL(request.url);
    const pathname = url.pathname;
    const method = request.method;

    // ---- Health (normally handled by the Worker) --------------------------
    if (pathname === '/api/health' && method === 'GET') {
      return jsonResponse(200, { ok: true, time: new Date().toISOString(), service: 'atlas-sync-worker' });
    }

    // ---- Auth: signup -----------------------------------------------------
    if (pathname === '/api/auth/signup' && method === 'POST') {
      const body = await readJson(request);
      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      const password = typeof body.password === 'string' ? body.password : '';
      const type = normalizeProfileType(body.type, 'personal');

      if (!EMAIL_RE.test(email)) fail(400, 'A valid email is required');
      if (name.length > 200) fail(400, 'Name is too long (max 200 characters)');
      if (password.length < 8) fail(400, 'Password must be at least 8 characters');
      if (this.one('SELECT 1 FROM users WHERE email = ?', email)) fail(409, 'Email already registered');

      // Name is optional; default to the email's local part (original contract).
      const displayName = name || email.split('@')[0] || 'Atlas user';
      const { salt, hash } = await hashSecret(password);
      const userId = crypto.randomUUID();
      const createdAt = new Date().toISOString();
      this.sql.exec(
        'INSERT INTO users (id, email, name, salt, hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        userId, email, displayName, salt, hash, createdAt,
      );
      const profile = this.createProfile(userId, type, safeString(body.profileName, displayName), createdAt);
      const token = this.issueToken(userId, profile.id);
      const user = publicUser({ id: userId, email, name: displayName }, type);
      return jsonResponse(201, { token, user, profile: publicProfile(profile), profiles: this.profilesFor(userId).map(publicProfile) });
    }

    // ---- Auth: login ------------------------------------------------------
    if (pathname === '/api/auth/login' && method === 'POST') {
      const body = await readJson(request);
      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
      const password = typeof body.password === 'string' ? body.password : '';
      const row = this.one('SELECT id, email, name, salt, hash FROM users WHERE email = ?', email);
      const valid = await verifySecret(password, row?.salt ?? DUMMY_SALT, row?.hash ?? DUMMY_HASH);
      if (!row || !valid) fail(401, 'Invalid email or password');

      const profiles = this.profilesFor(row.id);
      const requested = normalizeProfileType(body.type, null);
      const profile = profiles.find((candidate) => candidate.type === requested) ?? profiles[0];
      const token = this.issueToken(row.id, profile.id);
      const user = publicUser(row, profile.type);
      return jsonResponse(200, { token, user, profile: publicProfile(profile), profiles: profiles.map(publicProfile) });
    }

    // ---- Auth: capability check (auth optional) ---------------------------
    if (pathname === '/api/auth/check' && method === 'GET') {
      const rawType = url.searchParams.get('type');
      const requiredType = rawType ? normalizeProfileType(rawType, null) : null;
      if (rawType && !requiredType) fail(400, 'Invalid profile type');
      const token = this.tokenFromRequest(request, true);
      const auth = token ? this.resolveAuth(token) : null;
      const profileType = auth?.profile?.type ?? null;
      const profiles = auth ? auth.profiles.map(publicProfile) : [];
      const allowed = requiredType ? profileType === requiredType : Boolean(auth);
      return jsonResponse(200, { allowed, requiredType, profileType, profiles });
    }

    // ---- Current user -----------------------------------------------------
    if (pathname === '/api/me' && method === 'GET') {
      const auth = this.authenticate(request);
      return jsonResponse(200, {
        user: publicUser(auth.user, auth.profile.type),
        profile: publicProfile(auth.profile),
        profiles: auth.profiles.map(publicProfile),
      });
    }

    // ---- Profiles ---------------------------------------------------------
    if (pathname === '/api/profiles') {
      const auth = this.authenticate(request);
      if (method === 'GET') {
        return jsonResponse(200, {
          profiles: auth.profiles.map(publicProfile),
          profile: publicProfile(auth.profile),
        });
      }
      if (method === 'POST') {
        const body = await readJson(request);
        const type = normalizeProfileType(body.type, null);
        if (!type) fail(400, 'type must be one of: ' + PROFILE_TYPES.join(', '));
        if (auth.profiles.some((candidate) => candidate.type === type)) fail(409, 'Profile type already exists');
        const name = typeof body.name === 'string' && body.name.trim()
          ? body.name.trim()
          : `${auth.user.name}'s ${type} profile`;
        const profile = this.createProfile(auth.user.id, type, name);
        const token = this.issueToken(auth.user.id, profile.id);
        return jsonResponse(201, {
          token,
          user: publicUser(auth.user, type),
          profile: publicProfile(profile),
          profiles: this.profilesFor(auth.user.id).map(publicProfile),
        });
      }
    }

    // ---- Connector: create a 6-digit pairing code ------------------------
    if (pathname === '/api/connector/code' && method === 'POST') {
      const { user } = this.authenticate(request);
      this.enforce(`code:user:${user.id}`);
      this.enforce(`code:ip:${clientIp(request)}`);
      this.pruneCodes();

      const code = String(randomInt(1000000)).padStart(6, '0');
      const codeHash = await codeDigest(code, this.env?.CODE_PEPPER);
      const expiresAt = new Date(Date.now() + CODE_TTL_MS).toISOString();
      this.sql.exec(
        'INSERT INTO connector_codes (code_hash, user_id, expires_at, used, created_at) VALUES (?, ?, ?, 0, ?)',
        codeHash, user.id, expiresAt, new Date().toISOString(),
      );
      return jsonResponse(200, { code, expiresAt });
    }

    // ---- Connector: redeem code (no auth required) -----------------------
    if (pathname === '/api/connector/redeem' && method === 'POST') {
      const body = await readJson(request);
      const code = typeof body.code === 'string' ? body.code.trim() : '';
      if (!/^\d{6}$/.test(code)) fail(400, 'Code must be exactly 6 digits');
      this.enforce(`redeem:ip:${clientIp(request)}`);
      this.pruneCodes();

      const codeHash = await codeDigest(code, this.env?.CODE_PEPPER);
      const record = this.one('SELECT user_id, expires_at, used FROM connector_codes WHERE code_hash = ?', codeHash);
      if (!record || Number(record.used) === 1 || Date.parse(record.expires_at) <= Date.now()) {
        fail(400, 'Invalid or expired code');
      }
      // Single use: mark used before issuing a token.
      this.sql.exec('UPDATE connector_codes SET used = 1 WHERE code_hash = ?', codeHash);
      const user = this.one('SELECT id, email, name FROM users WHERE id = ?', record.user_id);
      if (!user) fail(400, 'Invalid or expired code');
      const profile = this.firstProfile(user.id);
      const token = this.issueToken(user.id, profile.id);
      return jsonResponse(200, {
        token,
        user: publicUser(user, profile.type),
        profile: publicProfile(profile),
        profiles: this.profilesFor(user.id).map(publicProfile),
      });
    }

    // ---- Connector status -------------------------------------------------
    if (pathname === '/api/connector/status' && method === 'GET') {
      const { user } = this.authenticate(request);
      const rows = this.query('SELECT app, updated_at FROM snapshots WHERE user_id = ?', user.id);
      const byApp = new Map(rows.map((row) => [row.app, row.updated_at]));
      const linked = {};
      const updatedAt = {};
      for (const app of APPS) {
        linked[app] = byApp.has(app);
        updatedAt[app] = byApp.get(app) ?? null;
      }
      return jsonResponse(200, { linked, updatedAt });
    }

    // ---- SSE event stream -------------------------------------------------
    if (pathname === '/api/events' && method === 'GET') {
      const auth = this.authenticate(request, { allowQueryToken: true });
      return this.openEventStream(request, auth.user.id);
    }

    // ---- Calendar: app-derived sync (before /events/:id) -----------------
    if (pathname === '/api/calendar/events/sync' && method === 'PUT') {
      return await this.syncCalendar(request);
    }

    // ---- Calendar: collection --------------------------------------------
    if (pathname === '/api/calendar/events') {
      const auth = this.authenticate(request);
      if (method === 'GET') return this.listCalendarEvents(url, auth);
      if (method === 'POST') return this.createCalendarEvent(request, auth);
    }

    // ---- Calendar: single event ------------------------------------------
    const calendarMatch = /^\/api\/calendar\/events\/([^/]+)$/.exec(pathname);
    if (calendarMatch) {
      const auth = this.authenticate(request);
      const id = decodeSegment(calendarMatch[1]);
      if (method === 'PATCH') return this.patchCalendarEvent(request, auth, id);
      if (method === 'DELETE') return this.deleteCalendarEvent(auth.user.id, id);
    }

    // ---- Calendar: on-demand derivation from snapshots -------------------
    if (pathname === '/api/calendar/derived' && method === 'GET') {
      const auth = this.authenticate(request);
      return jsonResponse(200, { events: this.deriveCalendarEvents(auth) });
    }

    // ---- Snapshots (original contract) -----------------------------------
    const snapshotMatch = /^\/api\/snapshot\/([^/]+)$/.exec(pathname);
    if (snapshotMatch) {
      const app = decodeSegment(snapshotMatch[1]);
      if (!APP_SET.has(app)) {
        fail(400, `Invalid app "${app}". Allowed apps: ${APPS.join(', ')}`, { extra: { allowed: APPS } });
      }
      // Personal/family tokens cannot read or write business/developer data.
      const required = APP_REQUIRED_PROFILE[app];
      if (required) this.requireProfileType(this.env, request, required);
      const { user } = this.authenticate(request);
      const record = this.one('SELECT data, updated_at FROM snapshots WHERE user_id = ? AND app = ?', user.id, app);

      if (method === 'GET') {
        return jsonResponse(200, {
          app,
          data: record ? safeParse(record.data) : null,
          updatedAt: record?.updated_at ?? null,
        });
      }

      if (method === 'PUT') {
        const body = await readJson(request);
        if (!Object.prototype.hasOwnProperty.call(body, 'data')) fail(400, 'Body must include "data"');
        const clientId = body.clientId === undefined || body.clientId === null ? null : body.clientId;
        if (clientId !== null && typeof clientId !== 'string') fail(400, 'clientId must be a string');
        const updatedAt = new Date().toISOString();
        this.sql.exec(
          'INSERT INTO snapshots (user_id, app, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, app) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at',
          user.id, app, JSON.stringify(body.data), updatedAt,
        );
        // Unchanged snapshot frame: writers can ignore their own clientId echo.
        this.broadcast(user.id, { app, updatedAt, clientId });
        return jsonResponse(200, { ok: true, updatedAt, clientId });
      }

      if (method === 'DELETE') {
        this.sql.exec('DELETE FROM snapshots WHERE user_id = ? AND app = ?', user.id, app);
        return jsonResponse(200, { ok: true });
      }
    }

    fail(404, 'Not found');
  }

  // ---- Auth/profile internals --------------------------------------------

  tokenFromRequest(request, allowQueryToken = false) {
    const header = request.headers.get('authorization') || '';
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    let token = match ? match[1].trim() : '';
    if (!token && allowQueryToken) {
      const url = new URL(request.url);
      token = String(url.searchParams.get('token') || url.searchParams.get('access_token') || '').trim();
    }
    return token;
  }

  authenticate(request, options = {}) {
    const challenge = { 'WWW-Authenticate': 'Bearer' };
    const token = this.tokenFromRequest(request, Boolean(options.allowQueryToken));
    if (!token) fail(401, 'Missing or invalid Authorization header or token query', { headers: challenge });
    const auth = this.resolveAuth(token);
    if (!auth) fail(401, 'Invalid token', { headers: challenge });
    return auth;
  }

  resolveAuth(token) {
    const row = this.one(
      'SELECT t.user_id AS id, t.profile_id, u.email, u.name FROM tokens t JOIN users u ON u.id = t.user_id WHERE t.token = ?',
      token,
    );
    if (!row) return null;
    let profiles = this.profilesFor(row.id);
    if (profiles.length === 0) {
      // Legacy accounts without profiles get a default personal profile.
      this.createProfile(row.id, 'personal', row.name, new Date().toISOString());
      profiles = this.profilesFor(row.id);
    }
    const bound = profiles.find((profile) => profile.id === row.profile_id) ?? null;
    const profile = bound ?? profiles[0];
    if (!bound) {
      this.sql.exec('UPDATE tokens SET profile_id = ? WHERE token = ? AND (profile_id IS NULL OR profile_id != ?)', profile.id, token, profile.id);
    }
    return { user: { id: row.id, email: row.email, name: row.name }, token, profile, profiles };
  }

  profilesFor(userId) {
    return this.query(
      'SELECT id, user_id, type, name, status, created_at FROM profiles WHERE user_id = ? ORDER BY created_at, rowid',
      userId,
    );
  }

  firstProfile(userId) {
    return this.profilesFor(userId)[0];
  }

  createProfile(userId, type, name, createdAt = new Date().toISOString()) {
    const id = crypto.randomUUID();
    this.sql.exec(
      'INSERT INTO profiles (id, user_id, type, name, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      id, userId, type, name, 'active', createdAt,
    );
    return { id, user_id: userId, type, name, status: 'active', created_at: createdAt };
  }

  issueToken(userId, profileId) {
    const token = toHex(randomBytes(32));
    this.sql.exec(
      'INSERT INTO tokens (token, user_id, profile_id, created_at) VALUES (?, ?, ?, ?)',
      token, userId, profileId ?? null, new Date().toISOString(),
    );
    return token;
  }

  /**
   * Profile gate for protected data endpoints. `env` is the DO's environment;
   * all API calls reach this object, so token/profile state is resolved here.
   */
  requireProfileType(env, request, allowedTypes) {
    const auth = this.authenticate(request);
    const allowed = Array.isArray(allowedTypes) ? allowedTypes : [allowedTypes];
    if (!allowed.includes(auth.profile.type)) {
      fail(403, 'forbidden', { extra: { requiredType: allowed[0] ?? null, code: 'PROFILE_REQUIRED' } });
    }
    return auth;
  }

  enforce(key) {
    const result = this.limiter.check(key);
    if (!result.allowed) {
      const retryAfter = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
      fail(429, 'Too many requests. Please try again later.', {
        extra: { retryAfter },
        headers: { 'Retry-After': String(retryAfter) },
      });
    }
  }

  pruneCodes() {
    this.sql.exec('DELETE FROM connector_codes WHERE used = 1 OR expires_at <= ?', new Date().toISOString());
  }

  // ---- SSE ---------------------------------------------------------------

  sseClientsFor(userId) {
    let clients = this.sseClients.get(userId);
    if (!clients) {
      clients = new Set();
      this.sseClients.set(userId, clients);
    }
    return clients;
  }

  openEventStream(request, userId) {
    const clients = this.sseClientsFor(userId);
    let subscriber = null;
    let timer = null;
    let closed = false;

    const cleanup = () => {
      if (closed) return;
      closed = true;
      if (timer !== null) clearInterval(timer);
      if (subscriber) {
        clients.delete(subscriber);
        if (clients.size === 0) this.sseClients.delete(userId);
        try { subscriber.controller.close(); } catch { /* already closed */ }
      }
    };

    const stream = new ReadableStream({
      start(controller) {
        subscriber = { controller, cleanup };
        clients.add(subscriber);
        controller.enqueue(TEXT.encode(': connected\n\n'));
        timer = setInterval(() => {
          if (closed) return;
          try {
            controller.enqueue(TEXT.encode(': ping\n\n'));
          } catch {
            cleanup();
          }
        }, SSE_PING_MS);
        if (request.signal) request.signal.addEventListener('abort', cleanup, { once: true });
      },
      cancel() {
        cleanup();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: corsHeaders({
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      }),
    });
  }

  broadcast(userId, event) {
    const clients = this.sseClients.get(userId);
    if (!clients) return;
    const frame = `event: snapshot\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of clients) {
      try {
        client.controller.enqueue(TEXT.encode(frame));
      } catch {
        client.cleanup();
      }
    }
  }

  broadcastCalendar(userId, payload) {
    const clients = this.sseClients.get(userId);
    if (!clients) return;
    const frame = `event: calendar\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of clients) {
      try {
        client.controller.enqueue(TEXT.encode(frame));
      } catch {
        client.cleanup();
      }
    }
  }

  // ---- Calendar internals ------------------------------------------------

  eventProfileId(body, auth) {
    const requested = normalizeProfileType(body?.type, null);
    if (!requested) return auth.profile.id;
    const profile = auth.profiles.find((candidate) => candidate.type === requested);
    if (!profile) fail(400, `No ${requested} profile exists for this account`);
    return profile.id;
  }

  eventRow(id) {
    return this.one(
      'SELECT e.*, p.type AS profile_type FROM calendar_events e LEFT JOIN profiles p ON p.id = e.profile_id WHERE e.id = ?',
      id,
    );
  }

  listCalendarEvents(url, auth) {
    let rows = this.query(
      'SELECT e.*, p.type AS profile_type FROM calendar_events e LEFT JOIN profiles p ON p.id = e.profile_id WHERE e.user_id = ? ORDER BY e.start_at, e.created_at',
      auth.user.id,
    );

    const typeParam = url.searchParams.get('type');
    if (typeParam) {
      const type = normalizeProfileType(typeParam, null);
      if (!type) fail(400, 'Invalid profile type');
      rows = rows.filter((row) => row.profile_type === type);
    }

    const fromRaw = url.searchParams.get('from');
    const toRaw = url.searchParams.get('to');
    const from = fromRaw ? Date.parse(fromRaw) : null;
    const to = toRaw ? Date.parse(toRaw) : null;
    if (fromRaw && !Number.isFinite(from)) fail(400, 'Invalid from date');
    if (toRaw && !Number.isFinite(to)) fail(400, 'Invalid to date');
    if (from !== null) {
      rows = rows.filter((row) => {
        const end = row.end_at ? Date.parse(row.end_at) : Date.parse(row.start_at);
        return Number.isFinite(end) && end >= from;
      });
    }
    if (to !== null) {
      rows = rows.filter((row) => {
        const start = Date.parse(row.start_at);
        return Number.isFinite(start) && start <= to;
      });
    }
    return jsonResponse(200, { events: rows.map(publicEvent) });
  }

  async createCalendarEvent(request, auth) {
    const body = await readJson(request);
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title) fail(400, 'title is required');
    const start = parseEventDate(body.start);
    if (!start) fail(400, 'start must be a valid date');
    const end = body.end === undefined || body.end === null || body.end === '' ? null : parseEventDate(body.end);
    if (body.end && !end) fail(400, 'end must be a valid date');

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.sql.exec(
      `INSERT INTO calendar_events
        (id, user_id, profile_id, app, source_id, title, description, start_at, end_at, all_day, location, category, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, auth.user.id, this.eventProfileId(body, auth), validateEventApp(body.app, CALENDAR_APP),
      title, safeString(body.description), start.value, end?.value ?? null,
      body.allDay === undefined ? (start.allDay ? 1 : 0) : (body.allDay ? 1 : 0),
      safeString(body.location), safeString(body.category), safeString(body.status, 'confirmed') || 'confirmed',
      now, now,
    );
    const event = publicEvent(this.eventRow(id));
    this.broadcastCalendar(auth.user.id, { action: 'upsert', event });
    return jsonResponse(201, { ok: true, event });
  }

  async patchCalendarEvent(request, auth, id) {
    const existing = this.one('SELECT * FROM calendar_events WHERE id = ? AND user_id = ?', id, auth.user.id);
    if (!existing) fail(404, 'Event not found');
    const body = await readJson(request);

    const fields = {
      title: existing.title,
      description: existing.description,
      start_at: existing.start_at,
      end_at: existing.end_at,
      all_day: existing.all_day,
      location: existing.location,
      category: existing.category,
      status: existing.status,
      profile_id: existing.profile_id,
      app: existing.app,
    };
    if (Object.prototype.hasOwnProperty.call(body, 'title')) {
      if (typeof body.title !== 'string' || !body.title.trim()) fail(400, 'title must be a non-empty string');
      fields.title = body.title.trim();
    }
    if (Object.prototype.hasOwnProperty.call(body, 'start')) {
      const start = parseEventDate(body.start);
      if (!start) fail(400, 'start must be a valid date');
      fields.start_at = start.value;
    }
    if (Object.prototype.hasOwnProperty.call(body, 'end')) {
      fields.end_at = body.end ? parseEventDate(body.end)?.value ?? null : null;
      if (body.end && !fields.end_at) fail(400, 'end must be a valid date');
    }
    if (Object.prototype.hasOwnProperty.call(body, 'allDay')) fields.all_day = body.allDay ? 1 : 0;
    for (const key of ['description', 'location', 'category', 'status']) {
      if (Object.prototype.hasOwnProperty.call(body, key)) fields[key] = safeString(body[key]);
    }
    if (Object.prototype.hasOwnProperty.call(body, 'type')) fields.profile_id = this.eventProfileId(body, auth);
    if (Object.prototype.hasOwnProperty.call(body, 'app')) {
      fields.app = validateEventApp(body.app, fields.app ?? CALENDAR_APP);
    }

    this.sql.exec(
      `UPDATE calendar_events SET profile_id = ?, app = ?, title = ?, description = ?, start_at = ?, end_at = ?,
        all_day = ?, location = ?, category = ?, status = ?, updated_at = ?
       WHERE id = ? AND user_id = ?`,
      fields.profile_id, fields.app, fields.title, fields.description, fields.start_at, fields.end_at,
      fields.all_day, fields.location, fields.category, fields.status, new Date().toISOString(), id, auth.user.id,
    );
    const event = publicEvent(this.eventRow(id));
    this.broadcastCalendar(auth.user.id, { action: 'upsert', event });
    return jsonResponse(200, { ok: true, event });
  }

  deleteCalendarEvent(userId, id) {
    const existing = this.one('SELECT id FROM calendar_events WHERE id = ? AND user_id = ?', id, userId);
    if (!existing) fail(404, 'Event not found');
    this.sql.exec('DELETE FROM calendar_events WHERE id = ? AND user_id = ?', id, userId);
    this.broadcastCalendar(userId, { action: 'delete', event: { id } });
    return jsonResponse(200, { ok: true });
  }

  async syncCalendar(request) {
    const auth = this.authenticate(request);
    const body = await readJson(request);
    const app = validateEventApp(body.app, null);
    if (!app) fail(400, 'app is required');
    if (app === CALENDAR_APP) fail(400, 'app must be one of: ' + APPS.join(', '));
    const required = APP_REQUIRED_PROFILE[app];
    if (required) this.requireProfileType(this.env, request, required);

    const prefix = typeof body.sourcePrefix === 'string' ? body.sourcePrefix.trim() : '';
    if (!prefix) fail(400, 'sourcePrefix is required');
    if (!Array.isArray(body.events)) fail(400, 'events must be an array');

    // Replace only this app's derived events for this user.
    const existing = this.query('SELECT id, source_id FROM calendar_events WHERE user_id = ?', auth.user.id);
    for (const row of existing) {
      if (typeof row.source_id === 'string' && row.source_id.startsWith(prefix)) {
        this.sql.exec('DELETE FROM calendar_events WHERE id = ?', row.id);
      }
    }

    const now = new Date().toISOString();
    let count = 0;
    for (const item of body.events) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const rawId = typeof item.sourceId === 'string' ? item.sourceId.trim() : '';
      const title = typeof item.title === 'string' ? item.title.trim() : '';
      const start = parseEventDate(item.start);
      if (!rawId || !title || !start) continue;
      const sourceId = rawId.startsWith(prefix) ? rawId : `${prefix}${rawId}`;
      const end = item.end ? parseEventDate(item.end) : null;
      const profileId = this.eventProfileId(item, auth);
      const id = crypto.randomUUID();
      this.sql.exec(
        `INSERT INTO calendar_events
          (id, user_id, profile_id, app, source_id, title, description, start_at, end_at, all_day, location, category, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, source_id) DO UPDATE SET
           profile_id = excluded.profile_id, app = excluded.app, title = excluded.title,
           description = excluded.description, start_at = excluded.start_at, end_at = excluded.end_at,
           all_day = excluded.all_day, location = excluded.location, category = excluded.category,
           status = excluded.status, updated_at = excluded.updated_at`,
        id, auth.user.id, profileId, app, sourceId, title, safeString(item.description), start.value,
        end?.value ?? null, item.allDay ? 1 : 0, safeString(item.location), safeString(item.category),
        safeString(item.status, 'confirmed') || 'confirmed', now, now,
      );
      count += 1;
    }

    this.broadcastCalendar(auth.user.id, { action: 'refresh', app });
    return jsonResponse(200, { ok: true, app, count });
  }

  deriveCalendarEvents(auth) {
    const snapshots = this.query('SELECT app, data, updated_at FROM snapshots WHERE user_id = ?', auth.user.id);
    const events = [];
    for (const snapshot of snapshots) {
      const specList = DERIVED_SPECS[snapshot.app];
      if (!specList) continue;
      const parsed = safeParse(snapshot.data);
      if (!parsed) continue;
      const preference = APP_PROFILE_PREFERENCE[snapshot.app] ?? ['personal'];
      const profile = auth.profiles.find((candidate) => preference.includes(candidate.type))
        ?? auth.profile ?? auth.profiles[0];
      const type = profile?.type ?? 'personal';

      for (const spec of specList) {
        const items = arrayFrom(parsed, spec.keys).slice(0, DERIVED_CAP);
        for (const [index, item] of items.entries()) {
          if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
          const date = parseEventDate(firstString(item, spec.dateKeys));
          if (!date) continue;
          const rawId = firstString(item, ['id', 'key', 'uuid']) || String(index + 1);
          events.push({
            id: null,
            profileId: profile?.id ?? null,
            type,
            app: snapshot.app,
            sourceId: `${snapshot.app}:${spec.collection}:${rawId}`,
            title: firstString(item, spec.titleKeys) || humanize(spec.collection),
            description: firstString(item, ['description', 'notes', 'memo']),
            start: date.value,
            end: null,
            allDay: date.allDay,
            location: firstString(item, ['location', 'place']),
            category: spec.collection,
            status: firstString(item, ['status'], 'confirmed'),
            createdAt: null,
            updatedAt: snapshot.updated_at ?? null,
          });
        }
      }
    }
    events.sort((a, b) => String(a.start).localeCompare(String(b.start)));
    return events;
  }
}

// ---------------------------------------------------------------------------
// Worker entry point
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    // ctx is accepted for the standard Worker signature; no background work is
    // needed because the Durable Object owns cleanup and timers.
    void ctx;
    if (request.method === 'OPTIONS') return noContent();

    const url = new URL(request.url);
    if (url.pathname === '/api/health' && request.method === 'GET') {
      return jsonResponse(200, { ok: true, time: new Date().toISOString(), service: 'atlas-sync-worker' });
    }
    if (url.pathname.startsWith('/api/')) {
      if (!env?.ATLAS_SYNC) return jsonResponse(500, { error: 'ATLAS_SYNC Durable Object binding is missing' });
      const stub = env.ATLAS_SYNC.get(env.ATLAS_SYNC.idFromName(GLOBAL_DO_NAME));
      return stub.fetch(request);
    }
    return jsonResponse(404, { error: 'Not found' });
  },
};
