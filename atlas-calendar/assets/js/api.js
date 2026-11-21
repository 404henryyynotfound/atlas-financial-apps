/* Atlas Sync API client. Every call resolves to a typed result so the UI can
   fall back to local-only mode when the endpoint is unreachable. */
import { DEFAULT_ENDPOINT } from './config.js';
import { state, getClientId } from './store.js';

function cleanEndpoint(value) {
  const s = String(value || '').trim().replace(/\/+$/, '');
  if (!s) return '';
  try {
    const url = new URL(s);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.toString().replace(/\/+$/, '');
  } catch { return ''; }
}

export function urlOverride() {
  try { return cleanEndpoint(new URLSearchParams(location.search).get('endpoint')); } catch { return ''; }
}

export function endpoint() {
  const s = state();
  return urlOverride() || cleanEndpoint(s.settings.syncEndpoint) || DEFAULT_ENDPOINT;
}

function controller(timeout) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);
  return { signal: ac.signal, done: () => clearTimeout(timer) };
}

export async function request(path, { method = 'GET', body, token, timeout = 8000, accept = 'application/json' } = {}) {
  const headers = { Accept: accept };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const bearer = token === undefined ? state().token : token;
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
        error: json?.error || json?.message || `Atlas Sync request failed (${res.status}).`,
      };
    }
    return { ok: true, status: res.status, data: json };
  } catch {
    return { ok: false, status: 0, data: null, error: 'Atlas Sync endpoint is unavailable.' };
  } finally { ctl.done(); }
}

/* ------------------------------ auth ------------------------------ */

export const signup = payload => request('/api/auth/signup', { method: 'POST', body: payload, token: null });
export const login = payload => request('/api/auth/login', { method: 'POST', body: payload, token: null });
export const me = () => request('/api/me');
export const listProfiles = () => request('/api/profiles');
export const createProfile = payload => request('/api/profiles', { method: 'POST', body: payload });
export function authCheck(type, token) {
  return request(`/api/auth/check?type=${encodeURIComponent(type)}`, { token });
}

/* ----------------------------- events ----------------------------- */

export function getEvents({ from, to, type = '' } = {}) {
  const query = new URLSearchParams();
  if (from) query.set('from', from);
  if (to) query.set('to', to);
  if (type) query.set('type', type);
  const suffix = query.toString();
  return request(`/api/calendar/events${suffix ? `?${suffix}` : ''}`);
}
export const createEvent = body => request('/api/calendar/events', { method: 'POST', body });
export const updateEvent = (id, patch) => request(`/api/calendar/events/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch });
export const deleteEvent = id => request(`/api/calendar/events/${encodeURIComponent(id)}`, { method: 'DELETE' });
export const getDerived = () => request('/api/calendar/derived');

/* Settings "Refresh derived events" only reads the derived feed; apps push
   their own snapshots with PUT /api/calendar/events/sync. */
export const refreshDerived = () => getDerived();

/* ---------------------------- snapshots ---------------------------- */

export function putCalendarSnapshot(data) {
  return request('/api/snapshot/calendar', { method: 'PUT', body: { data, clientId: getClientId() } });
}

/* --------------------------- live updates --------------------------- */

/* Native EventSource cannot set headers, so the token travels in the query
   string on this endpoint only. Reconnect uses exponential backoff. */
export function subscribeEvents({ token, onEvent, onStatus } = {}) {
  if (!token || typeof EventSource === 'undefined') {
    onStatus?.('offline');
    return { close() {} };
  }
  let closed = false;
  let source = null;
  let timer = null;
  let delay = 1000;

  function schedule() {
    if (closed) return;
    clearTimeout(timer);
    timer = setTimeout(connect, delay);
    delay = Math.min(delay * 2, 30000);
  }
  function handle(name) {
    return e => {
      try {
        const payload = JSON.parse(String(e.data || ''));
        onEvent?.(name, payload);
      } catch { /* ignore malformed frames */ }
    };
  }
  function connect() {
    if (closed) return;
    onStatus?.('connecting');
    try {
      source = new EventSource(`${endpoint()}/api/events?token=${encodeURIComponent(token)}`);
      source.addEventListener('snapshot', handle('snapshot'));
      source.addEventListener('calendar', handle('calendar'));
      source.onmessage = e => {
        try {
          const payload = JSON.parse(String(e.data || ''));
          if (payload && typeof payload === 'object') onEvent?.('message', payload);
        } catch { /* ignore */ }
      };
      source.onopen = () => { if (!closed) { delay = 1000; onStatus?.('live'); } };
      source.onerror = () => {
        if (closed) return;
        onStatus?.('offline');
        try { source?.close(); } catch { /* noop */ }
        source = null;
        schedule();
      };
    } catch {
      onStatus?.('offline');
      schedule();
    }
  }
  connect();
  return {
    close() {
      closed = true;
      clearTimeout(timer);
      try { source?.close(); } catch { /* noop */ }
      source = null;
    },
  };
}
