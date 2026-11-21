/* Meridian Connector — cloud account, pairing code and snapshot sync helpers.
   Talks to the atlas-sync service. Local-first data still lives in this browser;
   every call here fails soft so the rest of Meridian keeps working. */

const ENDPOINT_KEY = 'meridian.syncEndpoint';
const TOKEN_KEY = 'meridian.cloudToken';
const CLIENT_KEY = 'meridian.clientId';
const USER_KEY = 'meridian.cloudUser';
const LAST_SYNC_KEY = 'meridian.lastSyncAt';
const DEFAULT_ENDPOINT = 'https://atlas-sync.greenhenry441.workers.dev';

function read(key, fallback = null) {
  try {
    const value = localStorage.getItem(key);
    return value ?? fallback;
  } catch { return fallback; }
}

function write(key, value) {
  try { localStorage.setItem(key, value); } catch { /* storage disabled — in-memory only */ }
}

function remove(key) {
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}

function token() { return read(TOKEN_KEY, '') || ''; }

/* Current paired cloud token, exposed for integrations that need a bearer token. */
export function cloudToken() { return token(); }

export function endpoint() {
  return read(ENDPOINT_KEY, DEFAULT_ENDPOINT) || DEFAULT_ENDPOINT;
}

export function setEndpoint(url) {
  const clean = String(url || '').trim().replace(/\/+$/, '');
  write(ENDPOINT_KEY, clean || DEFAULT_ENDPOINT);
  return endpoint();
}

export function clientId() {
  let id = read(CLIENT_KEY, '');
  if (!id) {
    const cryptoObj = typeof crypto !== 'undefined' ? crypto : (typeof globalThis !== 'undefined' ? globalThis.crypto : null);
    id = (cryptoObj && typeof cryptoObj.randomUUID === 'function')
      ? cryptoObj.randomUUID()
      : `meridian_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    write(CLIENT_KEY, id);
  }
  return id;
}

/* True when the sync service answers /api/health. Never throws. */
export async function available() {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), 3500) : null;
  try {
    const res = await fetch(`${endpoint()}/api/health`, {
      method: 'GET', headers: { Accept: 'application/json' }, signal: controller ? controller.signal : undefined,
    });
    return !!res.ok;
  } catch { return false; }
  finally { if (timer) clearTimeout(timer); }
}

async function request(path, { method = 'GET', body, auth = true } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth) {
    if (!token()) throw new Error('Connect a cloud account first.');
    headers.Authorization = `Bearer ${token()}`;
  }

  let res;
  try {
    res = await fetch(`${endpoint()}${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error(`Sync server unreachable at ${endpoint()}. Check that it is running and try again.`);
  }

  let payload = null;
  try { payload = await res.json(); } catch { payload = null; }

  if (!res.ok) {
    let message = payload?.error || payload?.message;
    if (!message) {
      message = res.status === 401 ? 'Your cloud session expired. Reconnect your account.'
        : res.status === 404 ? 'The sync server does not support that request.'
          : `Sync server returned an error (${res.status}).`;
    }
    const err = new Error(String(message));
    err.status = res.status;
    throw err;
  }
  return payload || {};
}

function rememberSession(payload) {
  if (payload?.token) write(TOKEN_KEY, String(payload.token));
  const u = payload?.user;
  if (u && typeof u === 'object') {
    // Keep only display-safe fields; no password, salt or hash is ever stored here.
    write(USER_KEY, JSON.stringify({
      id: u.id ?? null,
      name: typeof u.name === 'string' ? u.name : '',
      email: typeof u.email === 'string' ? u.email : '',
    }));
  }
  return payload;
}

export async function signup({ email, name, password }) {
  const result = await request('/api/auth/signup', {
    method: 'POST', auth: false,
    body: { email, name, password },
  });
  return rememberSession(result);
}

export async function login({ email, password }) {
  const result = await request('/api/auth/login', {
    method: 'POST', auth: false,
    body: { email, password },
  });
  return rememberSession(result);
}

export async function requestCode() {
  return request('/api/connector/code', { method: 'POST' });
}

export async function redeemCode(code) {
  const result = await request('/api/connector/redeem', {
    method: 'POST', auth: false, body: { code: String(code || '').replace(/\D/g, '') },
  });
  return rememberSession(result);
}

export async function getSnapshot(app) {
  const name = app === 'airo' ? 'airo' : 'meridian';
  return request(`/api/snapshot/${name}`);
}

export async function putSnapshot(app, data, client = clientId()) {
  const name = app === 'airo' ? 'airo' : 'meridian';
  const result = await request(`/api/snapshot/${name}`, {
    method: 'PUT', body: { data, clientId: client || clientId() },
  });
  write(LAST_SYNC_KEY, String(result?.updatedAt || Date.now()));
  return result;
}

/* Live snapshot events over SSE. EventSource cannot send a Bearer header, so
   stream with fetch instead. Returns an unsubscribe function; never throws. */
export function subscribe(onEvent) {
  if (typeof onEvent !== 'function') return () => {};
  if (!token()) {
    onEvent({ type: 'error', message: 'Connect a cloud account to enable live sync.' });
    return () => {};
  }

  let closed = false;
  let controller = null;
  let retryTimer = null;
  let attempt = 0;

  const emit = payload => {
    if (closed) return;
    try { onEvent(payload); } catch { /* a bad listener must not break the stream */ }
  };

  const connect = async () => {
    if (closed || !token()) return;
    controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    try {
      const res = await fetch(`${endpoint()}/api/events`, {
        method: 'GET',
        headers: { Accept: 'text/event-stream', Authorization: `Bearer ${token()}` },
        signal: controller ? controller.signal : undefined,
      });
      if (!res.ok || !res.body) {
        const err = new Error(res.status === 401
          ? 'Your cloud session expired. Reconnect your account.'
          : `Live sync unavailable (${res.status}).`);
        err.status = res.status;
        throw err;
      }
      attempt = 0;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (!closed) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r/g, '');
        let split;
        while ((split = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          const lines = frame.split('\n').filter(line => line.startsWith('data:'));
          if (!lines.length) continue;
          const raw = lines.map(line => line.slice(5).trimStart()).join('\n');
          if (!raw.trim()) continue;
          let parsed;
          try { parsed = JSON.parse(raw); } catch { parsed = { raw }; }
          emit(parsed);
        }
      }
    } catch (err) {
      if (closed || err?.name === 'AbortError') return;
      if (err?.status === 401) {
        emit({ type: 'error', message: 'Your cloud session expired. Reconnect your account.' });
        return;
      }
      emit({ type: 'error', message: 'Live sync disconnected. Retrying…' });
    }
    if (closed || !token()) return;
    attempt += 1;
    const delay = Math.min(30000, 1000 * (2 ** Math.min(attempt, 5)));
    retryTimer = setTimeout(() => { connect().catch(() => {}); }, delay);
  };

  connect().catch(() => {});
  return () => {
    closed = true;
    if (retryTimer) clearTimeout(retryTimer);
    if (controller && typeof controller.abort === 'function') {
      try { controller.abort(); } catch { /* ignore */ }
    }
  };
}

export function signOut() {
  remove(TOKEN_KEY);
  remove(USER_KEY);
  remove(LAST_SYNC_KEY);
}

export function status() {
  const rawUser = read(USER_KEY, '');
  let user = null;
  try { user = rawUser ? JSON.parse(rawUser) : null; } catch { user = null; }
  const last = Number(read(LAST_SYNC_KEY, '0')) || 0;
  return {
    connected: !!token(),
    endpoint: endpoint(),
    clientId: clientId(),
    user,
    lastSyncAt: last || null,
  };
}
