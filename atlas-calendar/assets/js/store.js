/* Local-first state for Atlas Calendar. Everything lives under one namespaced
   localStorage key. Passwords are never stored — the profile-switch password
   is kept only in memory by the controller for the duration of that request. */
import { STORAGE, DEFAULT_ENDPOINT, TYPE_IDS, THEMES } from './config.js';
import { uid, safeParse, dateInput, safeType } from './utils.js';

const listeners = new Set();
let current = null;

export function defaults() {
  return {
    version: 1,
    token: '',
    user: null,
    profile: null,
    profiles: [],
    email: '',
    mode: 'local', // 'local' | 'cloud'
    settings: {
      theme: 'ink',
      syncEndpoint: DEFAULT_ENDPOINT,
      onboardingComplete: false,
      hiddenTypes: [],
      timeZone: 'auto',
      view: 'month',
      cursor: dateInput(),
      filterType: 'all',
    },
    events: [],   // manual events, including offline-created ones
    derived: [],  // cached derived events from other Atlas apps
    syncMeta: { lastSync: 0, lastDerived: 0, lastError: '' },
    clientId: uid('calendar'),
  };
}

export function normalize(input) {
  const base = defaults();
  if (!input || typeof input !== 'object' || Array.isArray(input)) return base;
  const settings = { ...base.settings, ...(input.settings && typeof input.settings === 'object' ? input.settings : {}) };
  settings.theme = THEMES.includes(settings.theme) ? settings.theme : 'ink';
  settings.syncEndpoint = String(settings.syncEndpoint || DEFAULT_ENDPOINT).trim() || DEFAULT_ENDPOINT;
  settings.timeZone = String(settings.timeZone || 'auto');
  settings.view = ['overview', 'month', 'week', 'agenda'].includes(settings.view) ? settings.view : 'month';
  settings.cursor = /^\d{4}-\d{2}-\d{2}$/.test(String(settings.cursor || '')) ? settings.cursor : base.settings.cursor;
  settings.filterType = ['all', ...TYPE_IDS].includes(settings.filterType) ? settings.filterType : 'all';
  settings.hiddenTypes = Array.isArray(settings.hiddenTypes)
    ? [...new Set(settings.hiddenTypes.filter(t => TYPE_IDS.includes(t)))] : [];
  settings.onboardingComplete = !!settings.onboardingComplete;

  const profiles = Array.isArray(input.profiles) ? input.profiles.filter(p => p && typeof p === 'object') : [];
  const profile = input.profile && typeof input.profile === 'object' ? input.profile : null;
  return {
    ...base, ...input,
    token: String(input.token || ''),
    email: String(input.email || ''),
    mode: input.mode === 'cloud' && input.token ? 'cloud' : 'local',
    user: input.user && typeof input.user === 'object' ? input.user : null,
    profile,
    profiles,
    settings,
    events: Array.isArray(input.events) ? input.events.filter(e => e && typeof e === 'object') : [],
    derived: Array.isArray(input.derived) ? input.derived.filter(e => e && typeof e === 'object') : [],
    syncMeta: { ...base.syncMeta, ...(input.syncMeta && typeof input.syncMeta === 'object' ? input.syncMeta : {}) },
    clientId: String(input.clientId || base.clientId),
  };
}

export function load() {
  if (current) return current;
  let raw = null;
  try { raw = localStorage.getItem(STORAGE.key); } catch { /* storage disabled */ }
  current = normalize(safeParse(raw, null));
  return current;
}

export function save() {
  try { localStorage.setItem(STORAGE.key, JSON.stringify(load())); return true; } catch { return false; }
}

export function state() { return load(); }

export function update(mutator, opts = {}) {
  const next = mutator(load()) || load();
  current = normalize(next);
  save();
  if (!opts.silent) emit(opts.source || 'local');
  return current;
}

export function replace(next, source = 'local') {
  current = normalize(next);
  save();
  emit(source);
  return current;
}

function emit(source) {
  listeners.forEach(fn => { try { fn(state(), { source }); } catch { /* non-fatal */ } });
}
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/* ----------------------------- session ----------------------------- */

export function setAuthResult(payload = {}, endpoint = '') {
  return update(s => {
    if (payload.token) s.token = String(payload.token);
    if (payload.user) s.user = payload.user;
    const list = Array.isArray(payload.profiles) ? payload.profiles : s.profiles;
    if (list.length) s.profiles = list;
    const profile = payload.profile || list.find(p => p && p.id === (s.profile?.id || payload.user?.activeProfileId)) || list[0] || null;
    if (profile) s.profile = profile;
    if (payload.user?.email || s.email) s.email = String(payload.user?.email || s.email);
    if (endpoint) s.settings.syncEndpoint = endpoint;
    s.mode = s.token ? 'cloud' : s.mode;
    return s;
  }, { source: 'auth' });
}

/* Offline sessions never receive a token and never persist a password. */
export function setLocalProfile(type, { name = '', email = '' } = {}) {
  const safe = safeType(type);
  return update(s => {
    let profile = s.profiles.find(p => safeType(p.type) === safe);
    if (!profile) {
      profile = { id: uid('profile'), type: safe, name: name || `${safe[0].toUpperCase()}${safe.slice(1)} (local)` };
      s.profiles = [...s.profiles, profile];
    }
    s.profile = profile;
    s.token = '';
    s.user = s.user || { name: name || profile.name, email: email || s.email || '' };
    if (email) s.email = String(email);
    s.mode = 'local';
    return s;
  }, { source: 'auth' });
}

export function setActiveProfile(type) {
  const safe = safeType(type);
  return update(s => {
    const found = s.profiles.find(p => safeType(p.type) === safe);
    if (found) s.profile = found;
    return s;
  }, { source: 'profile' });
}

export function hasProfile(type) {
  return state().profiles.some(p => safeType(p.type) === safeType(type));
}

export function activeType() { return safeType(state().profile?.type); }

export function signOut() {
  return update(s => {
    s.token = ''; s.user = null; s.profile = null; s.profiles = []; s.mode = 'local';
    return s;
  }, { source: 'auth' });
}

/* ---------------------------- preferences ---------------------------- */

export function getSetting(key) { return state().settings[key]; }
export function setSetting(key, value) {
  return update(s => { s.settings[key] = value; return s; }, { source: 'settings' });
}
export function setSettings(patch) {
  return update(s => { s.settings = { ...s.settings, ...patch }; return s; }, { source: 'settings' });
}
export function getClientId() { return state().clientId; }

export function setSyncMeta(patch) {
  return update(s => { s.syncMeta = { ...s.syncMeta, ...patch }; return s; }, { silent: true });
}

/* ------------------------------ events ------------------------------ */

export function cacheEvents(events) {
  return update(s => { s.events = Array.isArray(events) ? events : []; s.syncMeta.lastSync = Date.now(); s.syncMeta.lastError = ''; return s; }, { silent: true, source: 'events' });
}
export function cacheDerived(events) {
  return update(s => { s.derived = Array.isArray(events) ? events : []; s.syncMeta.lastDerived = Date.now(); return s; }, { silent: true, source: 'derived' });
}
export function cacheManualEvent(event) {
  if (!event || typeof event !== 'object') return state();
  return update(s => {
    const id = String(event.id || event._localId || '');
    const index = s.events.findIndex(e => String(e.id || e._localId) === id);
    if (index >= 0) s.events[index] = event; else s.events = [...s.events, event];
    return s;
  }, { source: 'events' });
}
export function removeManualEvent(id) {
  return update(s => {
    s.events = s.events.filter(e => String(e.id || e._localId) !== String(id));
    return s;
  }, { source: 'events' });
}

/* --------------------------- import / export -------------------------- */

export function exportPreferences() {
  const s = state();
  return JSON.stringify({
    app: 'Atlas Calendar',
    exportedAt: new Date().toISOString(),
    settings: s.settings,
    localEvents: s.events,
  }, null, 2);
}

export function importPreferences(json) {
  const parsed = typeof json === 'string' ? safeParse(json, null) : json;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'That file is not valid Atlas Calendar preferences.' };
  }
  const settings = parsed.settings && typeof parsed.settings === 'object' ? parsed.settings : parsed;
  if (!settings || (!('theme' in settings) && !('hiddenTypes' in settings) && !('timeZone' in settings) && !('view' in settings))) {
    return { ok: false, error: 'That file does not look like Atlas Calendar preferences.' };
  }
  update(s => {
    s.settings = { ...s.settings, ...settings };
    if (Array.isArray(parsed.localEvents)) s.events = parsed.localEvents.filter(e => e && typeof e === 'object');
    return s;
  }, { source: 'import' });
  return { ok: true, error: '' };
}

export function clearLocalData() {
  const s = state();
  return replace({
    ...s,
    events: [], derived: [],
    settings: { ...defaults().settings, syncEndpoint: s.settings.syncEndpoint },
    syncMeta: defaults().syncMeta,
  }, 'clear');
}
