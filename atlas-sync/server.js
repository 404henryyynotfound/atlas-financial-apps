/**
 * atlas-sync — zero-dependency cloud sync service for the Atlas Financial apps.
 *
 * Runs on Node 20+ using only built-in modules. State lives in a single JSON
 * file (data/store.json by default) written atomically via write + rename.
 *
 * Run directly:  node server.js
 * Import for tests: import { startServer } from './server.js';
 */

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_DATA_FILE = path.resolve(__dirname, 'data', 'store.json');
const PBKDF2_ITERATIONS = 150_000;
const KEY_BYTES = 32;
const SALT_BYTES = 16;
const CODE_TTL_MS = 10 * 60 * 1000;
const SSE_PING_MS = 20 * 1000;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT_MAX = 10;
const MAX_BODY_BYTES = 1024 * 1024;

const APPS = ['meridian', 'airo', 'tandem', 'business', 'developer'];
const APP_SET = new Set(APPS);
const PROFILE_TYPES = ['personal', 'family', 'business', 'developer'];
const PROFILE_TYPE_SET = new Set(PROFILE_TYPES);
// Apps whose data endpoints require a matching profile type. Other snapshots
// remain available to every profile type.
const REQUIRED_APP_PROFILE_TYPES = { business: 'business', developer: 'developer' };
// Calendar events have their own namespace; `calendar` is a valid event app
// but is deliberately not added to the connector status list (APPS).
const CALENDAR_APPS = [...APPS, 'calendar'];
const CALENDAR_APP_SET = new Set(CALENDAR_APPS);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Fields of app snapshots that can be turned into read-only calendar events.
const DERIVED_SOURCES = {
  airo: { recurring: ['nextDate'], goals: ['deadline'], invoices: ['dueDate'] },
  business: {
    payroll: ['date', 'payDate'],
    invoices: ['dueDate'],
    debts: ['dueDate'],
    employees: ['reviewDate'],
  },
  meridian: { goals: ['deadline'] },
  tandem: { expenses: ['date'] },
  developer: {
    invoices: ['dueDate'],
    subscriptions: ['nextDate'],
    payouts: ['date'],
    goals: ['deadline'],
  },
};

const pbkdf2 = promisify(crypto.pbkdf2);

function envPort() {
  const raw = process.env.PORT;
  if (raw === undefined || raw === '') return 8787;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value >= 0 ? value : 8787;
}

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

function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Expose-Headers', 'Retry-After');
  res.setHeader('Access-Control-Max-Age', '86400');
}

/** Read and parse a JSON object body (empty body -> {}). */
async function readJson(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) fail(413, 'Request body too large');
    chunks.push(chunk);
  }
  if (total === 0) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('not an object');
    }
    return value;
  } catch {
    fail(400, 'Invalid JSON body');
  }
}

function clientIp(req) {
  // Behind a proxy, X-Forwarded-For avoids rate-limiting every user as one IP.
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}

// ---------------------------------------------------------------------------
// Secret hashing (salted PBKDF2-SHA256, timing-safe comparison)
// ---------------------------------------------------------------------------

async function deriveKey(secret, saltHex, iterations = PBKDF2_ITERATIONS) {
  return pbkdf2(secret, Buffer.from(saltHex, 'hex'), iterations, KEY_BYTES, 'sha256');
}

async function hashSecret(secret) {
  const salt = crypto.randomBytes(SALT_BYTES).toString('hex');
  const hash = (await deriveKey(secret, salt)).toString('hex');
  return { salt, hash };
}

async function verifySecret(secret, salt, expectedHash) {
  if (typeof salt !== 'string' || typeof expectedHash !== 'string') return false;
  const expected = Buffer.from(expectedHash, 'hex');
  if (expected.length !== KEY_BYTES) return false;
  const actual = await deriveKey(secret, salt);
  return crypto.timingSafeEqual(expected, actual);
}

// Used for unknown emails so login timing does not reveal whether an account exists.
const DUMMY_SALT = '00'.repeat(SALT_BYTES);
const DUMMY_HASH = '00'.repeat(KEY_BYTES);

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function emptyState() {
  return { version: 1, users: [], tokens: {}, codes: {}, snapshots: {}, profiles: [], events: [] };
}

/** Tolerate older/partial files by filling in missing top-level collections. */
function normalizeState(raw) {
  const base = emptyState();
  if (!raw || typeof raw !== 'object') return base;
  return {
    version: raw.version ?? 1,
    users: Array.isArray(raw.users) ? raw.users : [],
    tokens: raw.tokens && typeof raw.tokens === 'object' ? raw.tokens : {},
    codes: raw.codes && typeof raw.codes === 'object' ? raw.codes : {},
    snapshots: raw.snapshots && typeof raw.snapshots === 'object' ? raw.snapshots : {},
    profiles: Array.isArray(raw.profiles) ? raw.profiles : [],
    events: Array.isArray(raw.events) ? raw.events : [],
  };
}

/**
 * Load the JSON file and expose an atomic persist().
 * Writes are serialized so concurrent requests cannot produce a partial or
 * out-of-order file. Each write goes to a temp file in the same directory,
 * then rename(2) swaps it into place.
 */
export async function createStore(dataFile = DEFAULT_DATA_FILE) {
  const file = path.resolve(dataFile);
  await fs.mkdir(path.dirname(file), { recursive: true });

  let state;
  try {
    state = normalizeState(JSON.parse(await fs.readFile(file, 'utf8')));
  } catch (err) {
    if (err.code === 'ENOENT') {
      state = emptyState();
    } else {
      // Never silently overwrite an unreadable file; keep a copy for recovery.
      const backup = `${file}.corrupt-${Date.now()}`;
      console.warn(`atlas-sync: could not read ${file} (${err.message}); backing up to ${backup} and starting empty`);
      await fs.rename(file, backup).catch(() => {});
      state = emptyState();
    }
  }

  let tail = Promise.resolve();

  function persist() {
    const snapshot = JSON.stringify(state);
    const write = tail.then(async () => {
      const tmp = path.join(
        path.dirname(file),
        `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`,
      );
      try {
        await fs.writeFile(tmp, snapshot, { mode: 0o600 });
        await fs.rename(tmp, file);
      } catch (err) {
        await fs.rm(tmp, { force: true }).catch(() => {});
        throw err;
      }
    });
    // Keep the chain alive after a failure, but still give this caller its own
    // promise so a failed write surfaces as a 500 on the request that caused it.
    tail = write.catch(() => {});
    return write;
  }

  return {
    file,
    get state() {
      return state;
    },
    persist,
    flush: () => tail,
  };
}

// ---------------------------------------------------------------------------
// Lightweight in-memory rate limiting
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
      const retryAfterMs = windowMs - (now - recent[0]);
      return { allowed: false, retryAfterMs };
    }
    recent.push(now);
    this.hits.set(key, recent);
    return { allowed: true };
  }
}

function enforce(limiter, key) {
  const result = limiter.check(key);
  if (!result.allowed) {
    const retryAfterSeconds = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
    fail(429, 'Too many requests. Please try again later.', {
      extra: { retryAfter: retryAfterSeconds },
      headers: { 'Retry-After': String(retryAfterSeconds) },
    });
  }
}

// ---------------------------------------------------------------------------
// Domain helpers
// ---------------------------------------------------------------------------

/** Public copy of a profile: only whitelisted, non-secret fields. */
function publicProfile(profile) {
  if (!profile || typeof profile !== 'object') return null;
  return {
    id: profile.id,
    userId: profile.userId,
    type: profile.type,
    name: profile.name,
    status: profile.status,
    createdAt: profile.createdAt,
  };
}

function profilesForUser(state, userId) {
  return state.profiles.filter((profile) => profile && profile.userId === userId);
}

function findProfile(state, userId, type) {
  return profilesForUser(state, userId).find((profile) => profile.type === type) || null;
}

function assertProfileTypeValue(type) {
  if (!PROFILE_TYPE_SET.has(type)) {
    fail(400, `Invalid profile type "${type}". Allowed types: ${PROFILE_TYPES.join(', ')}`, {
      extra: { allowed: PROFILE_TYPES },
    });
  }
  return type;
}

/** Optional type bodies omitting `type` mean the default personal profile. */
function requestedProfileType(value) {
  if (value === undefined || value === null || value === '') return 'personal';
  return assertProfileTypeValue(value);
}

/** Create or reuse the single profile of a given type for a user. */
function ensureProfile(state, user, type, name) {
  assertProfileTypeValue(type);
  const existing = findProfile(state, user.id, type);
  if (existing) return existing;
  const profile = {
    id: crypto.randomUUID(),
    userId: user.id,
    type,
    name: typeof name === 'string' && name.trim() ? name.trim() : user.name,
    status: 'active',
    createdAt: new Date().toISOString(),
  };
  state.profiles.push(profile);
  return profile;
}

function publicUser(user, profile, profiles) {
  // Deliberately whitelist fields: never leak passwordHash/passwordSalt.
  const visibleProfiles = (Array.isArray(profiles) ? profiles : [])
    .map(publicProfile)
    .filter(Boolean);
  const visibleProfile = publicProfile(profile);
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    type: visibleProfile?.type ?? null,
    profile: visibleProfile,
    profiles: visibleProfiles,
  };
}

function issueToken(state, userId, profileId = null) {
  const token = crypto.randomBytes(32).toString('hex');
  // expiresAt is reserved for future use; null means no expiry.
  state.tokens[token] = {
    userId,
    profileId: profileId ?? null,
    createdAt: new Date().toISOString(),
    expiresAt: null,
  };
  return token;
}

/** Profile bound to a token, falling back to the user's first profile. */
function tokenProfile(state, user, record) {
  const profiles = profilesForUser(state, user.id);
  return profiles.find((profile) => profile.id === record?.profileId) || profiles[0] || null;
}

function isDateString(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function assertAppSlug(value, label = 'app') {
  if (!CALENDAR_APP_SET.has(value)) {
    fail(400, `Invalid ${label} "${value}". Allowed apps: ${CALENDAR_APPS.join(', ')}`, {
      extra: { allowed: CALENDAR_APPS },
    });
  }
  return value;
}

function eventIdFor(userId, sourceId) {
  const digest = crypto.createHash('sha256').update(`${userId}${sourceId}`).digest('hex');
  return `evt_${digest.slice(0, 16)}`;
}

/** Canonical event shape used by manual events, sync and derived events. */
function makeEvent({ userId, profileId = null, app = 'calendar', sourceId = null, title, description = '', start, end = null, allDay = false, location = '', category = '', status = 'active', createdAt, updatedAt }) {
  const now = new Date().toISOString();
  return {
    id: sourceId ? eventIdFor(userId, sourceId) : crypto.randomUUID(),
    userId,
    profileId: profileId ?? null,
    app,
    sourceId: sourceId ?? null,
    title,
    description: description ?? '',
    start,
    end: end ?? null,
    allDay: Boolean(allDay),
    location: location ?? '',
    category: category ?? '',
    status: status ?? 'active',
    createdAt: createdAt || now,
    updatedAt: updatedAt || now,
  };
}

/** Extract optional event fields from a request body, validating supplied dates. */
function eventFieldsFrom(body) {
  const fields = {};
  if (body.title !== undefined) {
    if (typeof body.title !== 'string' || !body.title.trim()) fail(400, 'title must be a non-empty string');
    fields.title = body.title.trim();
  }
  if (body.description !== undefined) fields.description = String(body.description ?? '');
  if (body.location !== undefined) fields.location = String(body.location ?? '');
  if (body.category !== undefined) fields.category = String(body.category ?? '');
  if (body.status !== undefined) fields.status = String(body.status);
  if (body.allDay !== undefined) fields.allDay = Boolean(body.allDay);
  if (body.start !== undefined) {
    if (!isDateString(body.start)) fail(400, 'start must be a valid date string');
    fields.start = body.start;
  }
  if (body.end !== undefined) {
    if (body.end !== null && !isDateString(body.end)) fail(400, 'end must be a valid date string or null');
    fields.end = body.end;
  }
  return fields;
}

/** Read-only events derived from whatever app snapshots happen to be stored. */
function derivedEvents(state, user) {
  const snapshots = state.snapshots[user.id];
  if (!snapshots || typeof snapshots !== 'object') return [];
  const result = [];

  for (const [app, collections] of Object.entries(DERIVED_SOURCES)) {
    const data = snapshots[app]?.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
    const profileType = app === 'business' || app === 'developer' ? app : 'personal';
    const profile = findProfile(state, user.id, profileType) || tokenProfile(state, user, null);

    for (const [collection, dateFields] of Object.entries(collections)) {
      const rows = data[collection];
      if (!Array.isArray(rows)) continue;
      const candidates = [];

      rows.forEach((row, index) => {
        if (!row || typeof row !== 'object' || Array.isArray(row)) return;
        const start = dateFields.map((field) => row[field]).find(isDateString);
        if (!start) return;
        const sourceId = `${app}:${collection}:${row.id ?? row._id ?? index}`;
        const title = row.title || row.name || row.label || `${app} ${collection}`;
        candidates.push({
          sourceId,
          start,
          event: makeEvent({
            userId: user.id,
            profileId: profile?.id ?? null,
            app,
            sourceId,
            title: typeof title === 'string' ? title : String(title),
            description: row.description || row.notes || '',
            location: row.location || '',
            category: app,
            allDay: true,
            start,
            createdAt: snapshots[app]?.updatedAt,
            updatedAt: snapshots[app]?.updatedAt,
          }),
        });
      });

      // Keep derived expense noise bounded to the 25 most recent entries.
      const selected = app === 'tandem' && collection === 'expenses'
        ? candidates.sort((a, b) => Date.parse(b.start) - Date.parse(a.start)).slice(0, 25)
        : candidates;
      for (const candidate of selected) result.push(candidate.event);
    }
  }

  return result.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
}

function authenticate(req, state, options = {}) {
  const header = typeof req.headers.authorization === 'string' ? req.headers.authorization.trim() : '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  const challenge = { 'WWW-Authenticate': 'Bearer' };
  let token = match ? match[1].trim() : '';

  // Native EventSource cannot send custom headers, so the SSE endpoint also
  // accepts the token as a query parameter. Other endpoints stay header-only.
  if (!token && options.allowQueryToken) {
    const url = new URL(req.url || '/', 'http://localhost');
    token = String(url.searchParams.get('token') || url.searchParams.get('access_token') || '').trim();
  }

  if (!token) fail(401, 'Missing or invalid Authorization header or token query', { headers: challenge });

  const record = state.tokens[token];
  if (!record) fail(401, 'Invalid token', { headers: challenge });
  if (record.expiresAt && Date.parse(record.expiresAt) <= Date.now()) {
    fail(401, 'Token expired', { headers: challenge });
  }
  const user = state.users.find((candidate) => candidate.id === record.userId);
  if (!user) fail(401, 'Invalid token', { headers: challenge });
  return { user, token, record };
}

function assertApp(app) {
  if (!APP_SET.has(app)) {
    fail(400, `Invalid app "${app}". Allowed apps: ${APPS.join(', ')}`, { extra: { allowed: APPS } });
  }
}

function pruneCodes(state) {
  const now = Date.now();
  for (const [hash, record] of Object.entries(state.codes)) {
    if (record.usedAt || Date.parse(record.expiresAt) <= now) delete state.codes[hash];
  }
}

// ---------------------------------------------------------------------------
// Application (routing + SSE)
// ---------------------------------------------------------------------------

export function createApp(store) {
  const limiter = new RateLimiter();
  // userId -> Set<{res, timer}>. Only the owning user receives their events.
  const sseClients = new Map();

  function broadcast(userId, event, name = 'snapshot') {
    const clients = sseClients.get(userId);
    if (!clients) return;
    const frame = `event: ${name}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of clients) {
      if (client.res.destroyed || client.res.writableEnded) continue;
      try {
        client.res.write(frame);
      } catch {
        // A dead connection is cleaned up by its 'close' handler.
      }
    }
  }

  function handleEvents(req, res, user) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // disable proxy buffering (nginx)
    });
    res.flushHeaders?.();
    res.write(': connected\n\n');

    let clients = sseClients.get(user.id);
    if (!clients) {
      clients = new Set();
      sseClients.set(user.id, clients);
    }

    const client = { res, timer: null };
    function cleanup() {
      clearInterval(client.timer);
      clients.delete(client);
      if (clients.size === 0) sseClients.delete(user.id);
    }

    client.timer = setInterval(() => {
      if (res.destroyed || res.writableEnded) return cleanup();
      try {
        res.write(': ping\n\n');
      } catch {
        cleanup();
      }
    }, SSE_PING_MS);

    clients.add(client);
    // 'close' on the response fires when the client disconnects.
    res.on('close', cleanup);
    res.on('error', cleanup);
  }

  async function handle(req, res) {
    setCorsHeaders(res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const state = store.state;
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    const { pathname } = requestUrl;

    /**
     * Guard a data endpoint that implies a profile type. A token bound to a
     * different type gets a 403 with the available profiles so the UI can show
     * a "Create/switch profile" CTA instead of a blank screen.
     */
    function assertProfileType(user, tokenRecord, allowedTypes) {
      const profiles = profilesForUser(state, user.id);
      const required = Array.isArray(allowedTypes) ? allowedTypes : [allowedTypes];
      const bound = tokenProfile(state, user, tokenRecord);
      if (bound && required.includes(bound.type)) return;
      fail(403, 'Forbidden', {
        extra: {
          requiredType: required[0],
          code: 'PROFILE_REQUIRED',
          profiles: profiles.map(publicProfile).filter(Boolean),
        },
      });
    }

    // ---- Health -----------------------------------------------------------
    if (pathname === '/api/health' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, time: new Date().toISOString() });
    }

    // ---- Auth: signup -----------------------------------------------------
    if (pathname === '/api/auth/signup' && req.method === 'POST') {
      const body = await readJson(req);
      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      const password = typeof body.password === 'string' ? body.password : '';
      const type = requestedProfileType(body.type);

      if (!EMAIL_RE.test(email)) fail(400, 'A valid email is required');
      if (!name || name.length > 200) fail(400, 'Name is required (max 200 characters)');
      if (password.length < 8) fail(400, 'Password must be at least 8 characters');
      if (state.users.some((user) => user.email === email)) fail(409, 'Email already registered');

      const { salt, hash } = await hashSecret(password);
      const user = {
        id: crypto.randomUUID(),
        email,
        name,
        passwordSalt: salt,
        passwordHash: hash,
        createdAt: new Date().toISOString(),
      };
      state.users.push(user);
      const profile = ensureProfile(state, user, type, user.name);
      const profiles = profilesForUser(state, user.id);
      const token = issueToken(state, user.id, profile.id);
      await store.persist();
      return sendJson(res, 201, {
        token,
        user: publicUser(user, profile, profiles),
        profile: publicProfile(profile),
        profiles: profiles.map(publicProfile).filter(Boolean),
      });
    }

    // ---- Auth: login ------------------------------------------------------
    if (pathname === '/api/auth/login' && req.method === 'POST') {
      const body = await readJson(req);
      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
      const password = typeof body.password === 'string' ? body.password : '';
      const requestedType = body.type === undefined || body.type === null || body.type === ''
        ? null
        : assertProfileTypeValue(body.type);
      const user = state.users.find((candidate) => candidate.email === email);

      const valid = await verifySecret(
        password,
        user?.passwordSalt ?? DUMMY_SALT,
        user?.passwordHash ?? DUMMY_HASH,
      );
      if (!user || !valid) fail(401, 'Invalid email or password');

      // Legacy accounts have no profiles yet: give them a personal one.
      if (profilesForUser(state, user.id).length === 0) ensureProfile(state, user, 'personal', user.name);
      const profiles = profilesForUser(state, user.id);
      const profile = (requestedType && findProfile(state, user.id, requestedType)) || profiles[0];
      const token = issueToken(state, user.id, profile.id);
      await store.persist();
      return sendJson(res, 200, {
        token,
        user: publicUser(user, profile, profiles),
        profile: publicProfile(profile),
        profiles: profiles.map(publicProfile).filter(Boolean),
      });
    }

    // ---- Current user -----------------------------------------------------
    if (pathname === '/api/me' && req.method === 'GET') {
      const { user, record } = authenticate(req, state);
      const profiles = profilesForUser(state, user.id);
      const profile = tokenProfile(state, user, record);
      return sendJson(res, 200, {
        user: publicUser(user, profile, profiles),
        profile: publicProfile(profile),
        profiles: profiles.map(publicProfile).filter(Boolean),
      });
    }

    // ---- Profiles: list ----------------------------------------------------
    if (pathname === '/api/profiles' && req.method === 'GET') {
      const { user } = authenticate(req, state);
      const profiles = profilesForUser(state, user.id).map(publicProfile).filter(Boolean);
      return sendJson(res, 200, { profiles });
    }

    // ---- Profiles: add another type for the same account ------------------
    if (pathname === '/api/profiles' && req.method === 'POST') {
      const { user } = authenticate(req, state);
      const body = await readJson(req);
      const type = requestedProfileType(body.type);
      const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : user.name;

      const profile = ensureProfile(state, user, type, name);
      const profiles = profilesForUser(state, user.id);
      // Switching profile means switching token; the caller stores the new one.
      const token = issueToken(state, user.id, profile.id);
      await store.persist();
      return sendJson(res, 200, {
        token,
        user: publicUser(user, profile, profiles),
        profile: publicProfile(profile),
        profiles: profiles.map(publicProfile).filter(Boolean),
      });
    }

    // ---- Profile access check (Bearer or ?token=) -------------------------
    if (pathname === '/api/auth/check' && req.method === 'GET') {
      const rawType = requestUrl.searchParams.get('type');
      const requiredType = assertProfileTypeValue(rawType === null ? undefined : rawType.trim());
      const { user, record } = authenticate(req, state, { allowQueryToken: true });
      const profiles = profilesForUser(state, user.id);
      const profileType = tokenProfile(state, user, record)?.type ?? null;
      const allowed = profiles.some((profile) => profile.type === requiredType);
      return sendJson(res, 200, {
        allowed,
        requiredType,
        profileType,
        profiles: profiles.map(publicProfile).filter(Boolean),
        needsSwitch: Boolean(allowed && profileType !== requiredType),
      });
    }

    // ---- Connector: create a 6-digit pairing code ------------------------
    if (pathname === '/api/connector/code' && req.method === 'POST') {
      const { user, record } = authenticate(req, state);
      const codeProfile = tokenProfile(state, user, record);
      enforce(limiter, `code:user:${user.id}`);
      enforce(limiter, `code:ip:${clientIp(req)}`);
      pruneCodes(state);

      const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
      const { salt, hash } = await hashSecret(code);
      const expiresAt = new Date(Date.now() + CODE_TTL_MS).toISOString();
      // Only the salted hash is stored; the plain code exists only in this response.
      state.codes[hash] = {
        salt,
        userId: user.id,
        profileId: codeProfile?.id ?? null,
        createdAt: new Date().toISOString(),
        expiresAt,
        usedAt: null,
      };
      await store.persist();
      return sendJson(res, 200, { code, expiresAt });
    }

    // ---- Connector: redeem code (no auth required) -----------------------
    if (pathname === '/api/connector/redeem' && req.method === 'POST') {
      const body = await readJson(req);
      const code = typeof body.code === 'string' ? body.code.trim() : '';
      if (!/^\d{6}$/.test(code)) fail(400, 'Code must be exactly 6 digits');

      enforce(limiter, `redeem:ip:${clientIp(req)}`);
      pruneCodes(state);

      let match = null;
      for (const [hash, record] of Object.entries(state.codes)) {
        if (record.usedAt || Date.parse(record.expiresAt) <= Date.now()) continue;
        if (await verifySecret(code, record.salt, hash)) {
          match = { hash, record };
          break;
        }
      }
      if (!match) fail(400, 'Invalid or expired code');

      // Single use: remove it immediately, before issuing the token.
      delete state.codes[match.hash];
      const user = state.users.find((candidate) => candidate.id === match.record.userId);
      if (!user) fail(400, 'Invalid or expired code');

      const pairedProfile = profilesForUser(state, user.id)
        .find((profile) => profile.id === match.record.profileId) || profilesForUser(state, user.id)[0];
      const token = issueToken(state, user.id, pairedProfile?.id ?? null);
      await store.persist();
      return sendJson(res, 200, {
        token,
        user: publicUser(user, pairedProfile, profilesForUser(state, user.id)),
        profile: publicProfile(pairedProfile),
        profiles: profilesForUser(state, user.id).map(publicProfile).filter(Boolean),
      });
    }

    // ---- Connector status -------------------------------------------------
    if (pathname === '/api/connector/status' && req.method === 'GET') {
      const { user } = authenticate(req, state);
      const snapshots = state.snapshots[user.id] || {};
      const linked = {};
      const updatedAt = {};
      for (const app of APPS) {
        linked[app] = Boolean(snapshots[app]);
        updatedAt[app] = snapshots[app]?.updatedAt ?? null;
      }
      return sendJson(res, 200, { linked, updatedAt });
    }

    // ---- SSE event stream -------------------------------------------------
    if (pathname === '/api/events' && req.method === 'GET') {
      const { user } = authenticate(req, state, { allowQueryToken: true });
      handleEvents(req, res, user);
      return; // keep the response open
    }

    // ---- Snapshots --------------------------------------------------------
    const snapshotMatch = /^\/api\/snapshot\/([^/]+)$/.exec(pathname);
    if (snapshotMatch) {
      const app = decodeURIComponent(snapshotMatch[1]);
      const { user, record: tokenRecord } = authenticate(req, state);
      assertApp(app);
      if (REQUIRED_APP_PROFILE_TYPES[app]) {
        assertProfileType(user, tokenRecord, [REQUIRED_APP_PROFILE_TYPES[app]]);
      }
      const userSnapshots = state.snapshots[user.id] || {};
      const record = userSnapshots[app];

      if (req.method === 'GET') {
        return sendJson(res, 200, {
          app,
          data: record ? record.data : null,
          updatedAt: record ? record.updatedAt : null,
        });
      }

      if (req.method === 'PUT') {
        const body = await readJson(req);
        if (!Object.prototype.hasOwnProperty.call(body, 'data')) {
          fail(400, 'Body must include "data"');
        }
        const clientId = body.clientId === undefined || body.clientId === null ? null : body.clientId;
        if (clientId !== null && typeof clientId !== 'string') {
          fail(400, 'clientId must be a string');
        }

        const updatedAt = new Date().toISOString();
        if (!state.snapshots[user.id]) state.snapshots[user.id] = {};
        state.snapshots[user.id][app] = { data: body.data, updatedAt, clientId };
        await store.persist();

        // Broadcast only after a successful write. The writer can compare
        // clientId to its own id and ignore the echo.
        broadcast(user.id, { app, updatedAt, clientId });
        return sendJson(res, 200, { ok: true, updatedAt, clientId });
      }

      if (req.method === 'DELETE') {
        if (state.snapshots[user.id]) delete state.snapshots[user.id][app];
        await store.persist();
        return sendJson(res, 200, { ok: true });
      }
    }

    // ---- Calendar: sync events from an app --------------------------------
    if (pathname === '/api/calendar/events/sync' && req.method === 'PUT') {
      const { user, record } = authenticate(req, state);
      const body = await readJson(req);
      const app = assertAppSlug(body.app);
      if (typeof body.sourcePrefix !== 'string' || !body.sourcePrefix) {
        fail(400, 'sourcePrefix must be a non-empty string');
      }
      if (!Array.isArray(body.events)) fail(400, 'events must be an array');

      let defaultProfile = tokenProfile(state, user, record);
      if (!defaultProfile) defaultProfile = ensureProfile(state, user, 'personal', user.name);

      const existingById = new Map(
        state.events
          .filter((event) => event && event.userId === user.id)
          .map((event) => [event.id, event]),
      );
      const incoming = [];
      for (const raw of body.events) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
        if (typeof raw.sourceId !== 'string' || !raw.sourceId.trim()) {
          fail(400, 'each synced event requires a non-empty sourceId');
        }
        const fields = eventFieldsFrom(raw);
        if (!fields.title) fail(400, 'each synced event requires a title');
        if (!fields.start) fail(400, 'each synced event requires a valid start');

        let profile = defaultProfile;
        if (raw.type !== undefined && raw.type !== null && raw.type !== '') {
          const type = assertProfileTypeValue(raw.type);
          profile = findProfile(state, user.id, type);
          if (!profile) {
            fail(403, 'Forbidden', {
              extra: {
                requiredType: type,
                code: 'PROFILE_REQUIRED',
                profiles: profilesForUser(state, user.id).map(publicProfile).filter(Boolean),
              },
            });
          }
        }
        incoming.push(makeEvent({
          userId: user.id,
          profileId: profile.id,
          app,
          sourceId: raw.sourceId.trim(),
          ...fields,
        }));
      }

      const incomingIds = new Set(incoming.map((event) => event.id));
      const upserted = incoming.map((event) => {
        const previous = existingById.get(event.id);
        return previous ? { ...event, createdAt: previous.createdAt || event.createdAt } : event;
      });
      state.events = state.events.filter((event) => {
        if (!event || event.userId !== user.id) return true;
        if (incomingIds.has(event.id)) return false;
        return !(typeof event.sourceId === 'string' && event.sourceId.startsWith(body.sourcePrefix));
      }).concat(upserted);

      await store.persist();
      // App-level refresh: clients re-fetch /api/calendar/events after this.
      broadcast(user.id, { action: 'refresh', app }, 'calendar');
      return sendJson(res, 200, { ok: true, count: upserted.length });
    }

    // ---- Calendar: read-only events derived from stored snapshots ---------
    if (pathname === '/api/calendar/derived' && req.method === 'GET') {
      const { user } = authenticate(req, state);
      return sendJson(res, 200, { events: derivedEvents(state, user) });
    }

    // ---- Calendar: list / create events -----------------------------------
    if (pathname === '/api/calendar/events') {
      const { user, record } = authenticate(req, state);

      if (req.method === 'GET') {
        const fromRaw = requestUrl.searchParams.get('from');
        const toRaw = requestUrl.searchParams.get('to');
        const typeRaw = requestUrl.searchParams.get('type');
        if (fromRaw !== null && !isDateString(fromRaw)) fail(400, 'from must be a valid date string');
        if (toRaw !== null && !isDateString(toRaw)) fail(400, 'to must be a valid date string');
        const type = typeRaw && typeRaw.trim() ? assertProfileTypeValue(typeRaw.trim()) : null;
        const from = fromRaw === null ? null : Date.parse(fromRaw);
        const to = toRaw === null ? null : Date.parse(toRaw);
        const targetProfile = type ? findProfile(state, user.id, type) : null;

        const events = state.events
          .filter((event) => event && event.userId === user.id)
          .filter((event) => !targetProfile || event.profileId === targetProfile.id)
          .filter((event) => from === null || Date.parse(event.start) >= from)
          .filter((event) => to === null || Date.parse(event.start) <= to)
          .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
        return sendJson(res, 200, { events });
      }

      if (req.method === 'POST') {
        const body = await readJson(req);
        const fields = eventFieldsFrom(body);
        if (!fields.title) fail(400, 'title is required');
        if (!fields.start) fail(400, 'start is required');

        let profile = tokenProfile(state, user, record);
        if (body.type !== undefined && body.type !== null && body.type !== '') {
          const type = assertProfileTypeValue(body.type);
          profile = findProfile(state, user.id, type);
          if (!profile) {
            fail(403, 'Forbidden', {
              extra: {
                requiredType: type,
                code: 'PROFILE_REQUIRED',
                profiles: profilesForUser(state, user.id).map(publicProfile).filter(Boolean),
              },
            });
          }
        } else if (!profile) {
          profile = ensureProfile(state, user, 'personal', user.name);
        }
        const app = body.app === undefined || body.app === null || body.app === ''
          ? 'calendar'
          : assertAppSlug(body.app);
        const event = makeEvent({
          userId: user.id,
          profileId: profile.id,
          app,
          sourceId: null,
          ...fields,
        });
        state.events.push(event);
        await store.persist();
        broadcast(user.id, { action: 'create', event }, 'calendar');
        return sendJson(res, 201, { event });
      }
    }

    // ---- Calendar: update / delete a single event (owner only) ------------
    const eventMatch = /^\/api\/calendar\/events\/([^/]+)$/.exec(pathname);
    if (eventMatch && (req.method === 'PATCH' || req.method === 'DELETE')) {
      const { user } = authenticate(req, state);
      const id = decodeURIComponent(eventMatch[1]);
      const index = state.events.findIndex((event) => event && event.id === id && event.userId === user.id);
      if (index === -1) fail(404, 'Event not found');

      if (req.method === 'PATCH') {
        const body = await readJson(req);
        const fields = eventFieldsFrom(body);
        if (body.type !== undefined && body.type !== null && body.type !== '') {
          const type = assertProfileTypeValue(body.type);
          const profile = findProfile(state, user.id, type);
          if (!profile) {
            fail(403, 'Forbidden', {
              extra: {
                requiredType: type,
                code: 'PROFILE_REQUIRED',
                profiles: profilesForUser(state, user.id).map(publicProfile).filter(Boolean),
              },
            });
          }
          fields.profileId = profile.id;
        }
        if (body.app !== undefined) fields.app = assertAppSlug(body.app);
        const event = { ...state.events[index], ...fields, updatedAt: new Date().toISOString() };
        state.events[index] = event;
        await store.persist();
        broadcast(user.id, { action: 'update', event }, 'calendar');
        return sendJson(res, 200, { event });
      }

      const [deleted] = state.events.splice(index, 1);
      await store.persist();
      broadcast(user.id, { action: 'delete', event: deleted }, 'calendar');
      return sendJson(res, 200, { ok: true });
    }

    fail(404, 'Not found');
  }

  /** End all open SSE streams (used on shutdown / in tests). */
  function close() {
    for (const [userId, clients] of sseClients) {
      for (const client of clients) {
        clearInterval(client.timer);
        try {
          client.res.end();
        } catch {
          // already gone
        }
      }
      sseClients.delete(userId);
    }
  }

  return { handle, close };
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

export async function startServer({
  port = envPort(),
  dataFile = process.env.DATA_FILE || DEFAULT_DATA_FILE,
  host = '0.0.0.0',
  quiet = false,
} = {}) {
  const store = await createStore(dataFile);
  const app = createApp(store);

  const server = http.createServer((req, res) => {
    app.handle(req, res).catch((err) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (err instanceof ApiError) {
        sendJson(res, err.status, { error: err.message, ...err.extra }, err.headers);
      } else {
        console.error('atlas-sync: unexpected error:', err);
        sendJson(res, 500, { error: 'Internal server error' });
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const actualPort = server.address().port;
  if (!quiet) {
    console.log(`atlas-sync listening on http://${host}:${actualPort}`);
    console.log(`atlas-sync data file: ${store.file}`);
  }

  return {
    server,
    store,
    port: actualPort,
    async close() {
      app.close();
      await store.flush().catch(() => {});
      await new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      server.closeAllConnections?.();
    },
  };
}

// Only auto-start when executed directly (not when imported by test.js).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let instance;
  startServer()
    .then((started) => {
      instance = started;
    })
    .catch((err) => {
      console.error('atlas-sync failed to start:', err);
      process.exit(1);
    });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
      console.log(`\natlas-sync: received ${signal}, shutting down`);
      if (instance) await instance.close().catch((err) => console.error(err));
      process.exit(0);
    });
  }
}
