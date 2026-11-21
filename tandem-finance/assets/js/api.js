/* Cloud sync client for the Atlas Sync service.
   Every call degrades to a typed error; the app falls back to local-only mode
   when the configured endpoint cannot be reached. */
import { DEFAULT_SYNC_ENDPOINT } from './config.js';
import { getSyncEndpoint, cloudToken } from './store.js';

export function endpoint() { return getSyncEndpoint() || DEFAULT_SYNC_ENDPOINT; }

function controller(timeout) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);
  return { signal: ac.signal, done: () => clearTimeout(timer), abort: () => ac.abort() };
}

async function request(path, { method = 'GET', body, token, timeout = 8000 } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const bearer = token === undefined ? cloudToken() : token;
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  const ctl = controller(timeout);
  try {
    const res = await fetch(endpoint() + path, {
      method, headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctl.signal,
    });
    const text = await res.text();
    let json = null;
    if (text) { try { json = JSON.parse(text); } catch { json = null; } }
    if (!res.ok) {
      return {
        ok: false, status: res.status, data: json,
        error: json?.error || json?.message || `Cloud request failed (${res.status}).`,
      };
    }
    return { ok: true, status: res.status, data: json };
  } catch {
    return { ok: false, status: 0, data: null, error: 'Cloud endpoint is unavailable.' };
  } finally { ctl.done(); }
}

export const health = () => request('/api/health', { token: null, timeout: 5000 });
export const signup = payload => request('/api/auth/signup', { method: 'POST', body: payload, token: null });
export const login = payload => request('/api/auth/login', { method: 'POST', body: payload, token: null });
export const me = token => request('/api/me', { token });

export function getSnapshot(app, token) {
  return request(`/api/snapshot/${encodeURIComponent(app)}`, { token: token || cloudToken() });
}

/* The Atlas Sync snapshot contract expects the writer's clientId next to the
   data payload. It is used by event subscribers to ignore their own writes. */
export function putSnapshot(app, data, token, clientId) {
  return request(`/api/snapshot/${encodeURIComponent(app)}`, {
    method: 'PUT',
    body: { data, clientId },
    token: token || cloudToken(),
  });
}

/* EventSource cannot set an Authorization header, so Atlas Sync accepts the
   bearer token as a query parameter on /api/events only. The caller closes and
   recreates the subscription when the token or endpoint changes. */
export function subscribeEvents({ token, endpoint: endpointOverride, onSnapshot, onStatus } = {}) {
  const bearer = token || cloudToken();
  if (!bearer || typeof EventSource === 'undefined') return { close() {} };

  const base = String(endpointOverride || endpoint()).replace(/\/+$/, '');
  let closed = false;
  let source = null;

  function emitSnapshot(text) {
    try {
      const payload = JSON.parse(String(text).trim());
      if (payload && typeof payload === 'object') onSnapshot?.(payload);
    } catch { /* ignore malformed frames */ }
  }

  function connect() {
    if (closed) return;
    onStatus?.('connecting');
    try {
      const url = `${base}/api/events?token=${encodeURIComponent(bearer)}`;
      source = new EventSource(url);
      source.onopen = () => { if (!closed) onStatus?.('live'); };
      source.onmessage = e => emitSnapshot(e.data);
      source.onerror = () => { if (!closed) onStatus?.('offline'); };
    } catch {
      if (!closed) onStatus?.('offline');
    }
  }

  connect();
  return {
    close() {
      closed = true;
      if (source) {
        try { source.close(); } catch { /* noop */ }
        source = null;
      }
    },
  };
}
