/* Local-first persistence and credentials for Tandem.
   Local accounts use salted PBKDF2 (SHA-256) via Web Crypto. Cloud accounts
   keep a bearer token in this browser and mirror their data locally. */
import { STORAGE, DEFAULT_SYNC_ENDPOINT, CURRENCIES, GROUP_KINDS, SPLIT_METHODS } from './config.js';
import { uid, safeParse } from './utils.js';

const ITERATIONS = 120000;
const listeners = new Set();

function readJSON(key, fallback) { return safeParse(localStorage.getItem(key), fallback); }
function writeJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}
function toHex(buffer) {
  return [...new Uint8Array(buffer)].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function derive(password, saltHex) {
  const bytes = new TextEncoder().encode(String(password));
  const salt = new Uint8Array(String(saltHex).match(/.{2}/g)?.map(h => parseInt(h, 16)) || []);
  const key = await crypto.subtle.importKey('raw', bytes, 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS }, key, 256
  );
  return toHex(bits);
}
function numberMap(input) {
  const out = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  Object.entries(input).forEach(([key, value]) => {
    const n = Number(value);
    if (Number.isFinite(n)) out[String(key)] = n;
  });
  return out;
}

export function blankData() {
  return {
    settings: {
      currency: 'USD', theme: 'cream', name: '', syncEndpoint: '',
      cloudToken: '', onboardingComplete: false,
    },
    groups: [],
    expenses: [],
    settlements: [],
    activity: [],
  };
}

/* Merge stored / imported / remote objects into a predictable shape. */
export function sanitizeData(input) {
  const base = blankData();
  if (!input || typeof input !== 'object') return base;
  const rawSettings = input.settings && typeof input.settings === 'object' ? input.settings : {};
  const out = {
    settings: {
      currency: CURRENCIES.includes(rawSettings.currency) ? rawSettings.currency : base.settings.currency,
      theme: rawSettings.theme === 'plum' ? 'plum' : 'cream',
      name: String(rawSettings.name || '').slice(0, 120),
      syncEndpoint: String(rawSettings.syncEndpoint || ''),
      cloudToken: String(rawSettings.cloudToken || ''),
      onboardingComplete: !!rawSettings.onboardingComplete,
    },
    groups: [], expenses: [], settlements: [], activity: [],
  };

  out.groups = (Array.isArray(input.groups) ? input.groups : []).filter(g => g && typeof g === 'object').map(g => ({
    ...g,
    id: String(g.id || uid('grp')),
    name: String(g.name || 'Untitled group').slice(0, 120),
    emoji: String(g.emoji || '🧾').slice(0, 8),
    kind: GROUP_KINDS.includes(g.kind) ? g.kind : 'Other',
    members: (Array.isArray(g.members) ? g.members : []).filter(m => m && typeof m === 'object').map(m => ({
      id: String(m.id || uid('mem')),
      name: String(m.name || 'Member').slice(0, 120),
      email: String(m.email || '').slice(0, 160),
      color: String(m.color || '#e9685a'),
    })),
    createdAt: Number(g.createdAt) || Date.now(),
  }));

  out.expenses = (Array.isArray(input.expenses) ? input.expenses : []).filter(e => e && typeof e === 'object').map(e => ({
    ...e,
    id: String(e.id || uid('exp')),
    groupId: String(e.groupId || ''),
    date: String(e.date || new Date().toISOString().slice(0, 10)),
    title: String(e.title || 'Untitled expense').slice(0, 160),
    amount: Math.max(0, Number(e.amount) || 0),
    payerId: String(e.payerId || ''),
    split: SPLIT_METHODS.includes(e.split) ? e.split : 'equal',
    shares: numberMap(e.shares),
    custom: numberMap(e.custom),
    note: String(e.note || '').slice(0, 1000),
    category: String(e.category || 'Other').slice(0, 80),
  }));

  out.settlements = (Array.isArray(input.settlements) ? input.settlements : []).filter(s => s && typeof s === 'object').map(s => ({
    ...s,
    id: String(s.id || uid('set')),
    groupId: String(s.groupId || ''),
    date: String(s.date || new Date().toISOString().slice(0, 10)),
    fromId: String(s.fromId || ''),
    toId: String(s.toId || ''),
    amount: Math.max(0, Number(s.amount) || 0),
    note: String(s.note || '').slice(0, 1000),
  }));

  out.activity = Array.isArray(input.activity) ? input.activity.slice(0, 500) : [];
  if (!out.settings.syncEndpoint) out.settings.syncEndpoint = DEFAULT_SYNC_ENDPOINT;
  return out;
}

function emit(source = 'local') { listeners.forEach(fn => { try { fn(data(), { source }); } catch { /* non-fatal */ } }); }
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/* ------------------------------ sessions ------------------------------ */

export function listUsers() { return readJSON(STORAGE.users, []); }
export function session() { return readJSON(STORAGE.session, null); }
export function authMode() { return session()?.mode || null; }

export function currentUser() {
  const s = session();
  if (!s) return null;
  if (s.mode === 'cloud') return s.user || null;
  if (!s.userId) return null;
  const user = listUsers().find(u => u.id === s.userId);
  if (!user) { localStorage.removeItem(STORAGE.session); return null; }
  return user;
}

export function cloudToken() {
  const s = session();
  if (s?.mode !== 'cloud') return '';
  return s.token || data().settings.cloudToken || '';
}

export function setLocalSession(userId) { writeJSON(STORAGE.session, { mode: 'local', userId, at: Date.now() }); }

export function setCloudSession({ token, user, endpoint }) {
  writeJSON(STORAGE.session, { mode: 'cloud', token, user, at: Date.now() });
  updateData(d => {
    d.settings.cloudToken = token || '';
    d.settings.name = d.settings.name || user?.name || '';
    if (endpoint) d.settings.syncEndpoint = endpoint;
  });
}

export function refreshCloudUser(user) {
  const s = session();
  if (s?.mode !== 'cloud') return;
  writeJSON(STORAGE.session, { ...s, user, at: Date.now() });
}

export function signOut() {
  const current = data();
  current.settings.cloudToken = '';
  saveData(current);
  localStorage.removeItem(STORAGE.session);
  emit('local');
}

export async function createUser({ name, email, password }) {
  const norm = String(email || '').trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(norm)) return { ok: false, error: 'Enter a valid email address.' };
  if (String(password || '').length < 8) return { ok: false, error: 'Use a password of at least 8 characters.' };
  if (listUsers().some(u => u.email === norm)) return { ok: false, error: 'A local account with that email already exists in this browser.' };
  const salt = toHex(crypto.getRandomValues(new Uint8Array(16)));
  const user = {
    id: uid('usr'), name: String(name || norm.split('@')[0]).trim(),
    email: norm, salt, hash: await derive(password, salt), createdAt: Date.now(),
  };
  const users = listUsers();
  users.push(user);
  if (!writeJSON(STORAGE.users, users)) return { ok: false, error: 'This browser could not save the account.' };
  writeJSON(STORAGE.dataPrefix + user.id, blankData());
  setLocalSession(user.id);
  return { ok: true, user };
}

export async function signIn(email, password) {
  const norm = String(email || '').trim().toLowerCase();
  const user = listUsers().find(u => u.email === norm);
  if (!user) return { ok: false, error: 'No local account found for that email in this browser.' };
  const hash = await derive(password, user.salt);
  if (hash !== user.hash) return { ok: false, error: 'Incorrect password.' };
  setLocalSession(user.id);
  return { ok: true, user };
}

export function deleteAccount() {
  const user = currentUser();
  const s = session();
  if (user && s?.mode === 'local') {
    localStorage.removeItem(STORAGE.dataPrefix + user.id);
    writeJSON(STORAGE.users, listUsers().filter(u => u.id !== user.id));
  }
  signOut();
}

/* ------------------------------- data --------------------------------- */

export function data() {
  const user = currentUser();
  if (!user) return blankData();
  return sanitizeData(readJSON(STORAGE.dataPrefix + user.id, null));
}

export function saveData(next) {
  const user = currentUser();
  if (!user) return false;
  return writeJSON(STORAGE.dataPrefix + user.id, sanitizeData(next));
}

export function updateData(mutator, opts = {}) {
  const next = data();
  const result = mutator(next) ?? next;
  saveData(result);
  emit(opts.source || 'local');
  return result;
}

export function replaceData(next, source = 'remote') {
  saveData(next);
  emit(source);
  return data();
}

export function getPrefs() { return data().settings; }

export function setPref(key, value) { return updateData(d => { d.settings[key] = value; }); }

export function setPrefs(patch) {
  return updateData(d => { Object.assign(d.settings, patch); });
}

export function getSyncEndpoint() {
  const stored = localStorage.getItem(STORAGE.syncEndpoint);
  const fromData = data().settings.syncEndpoint;
  return String(stored || fromData || DEFAULT_SYNC_ENDPOINT).replace(/\/+$/, '');
}

export function setSyncEndpoint(value) {
  const endpoint = String(value || '').trim().replace(/\/+$/, '') || DEFAULT_SYNC_ENDPOINT;
  localStorage.setItem(STORAGE.syncEndpoint, endpoint);
  updateData(d => { d.settings.syncEndpoint = endpoint; });
  return endpoint;
}

export function clientId() {
  let id = localStorage.getItem(STORAGE.clientId);
  if (!id) { id = uid('client'); localStorage.setItem(STORAGE.clientId, id); }
  return id;
}

export function getSyncMeta() { return readJSON(STORAGE.syncMeta, { lastSync: 0, remoteAt: 0 }); }
export function setSyncMeta(patch) {
  const next = { ...getSyncMeta(), ...patch };
  writeJSON(STORAGE.syncMeta, next);
  return next;
}

export function exportData() {
  const clean = sanitizeData(data());
  clean.settings.cloudToken = '';
  return JSON.stringify({ app: 'Tandem Finance', exportedAt: new Date().toISOString(), data: clean }, null, 2);
}

export function importData(json) {
  const parsed = typeof json === 'string' ? safeParse(json, null) : json;
  const candidate = parsed?.data && typeof parsed.data === 'object' ? parsed.data : parsed;
  const looksLikeTandem = candidate && typeof candidate === 'object'
    && Array.isArray(candidate.groups) && Array.isArray(candidate.expenses) && Array.isArray(candidate.settlements);
  if (!looksLikeTandem) return { ok: false, error: 'That file is not a Tandem Finance export.' };
  const clean = sanitizeData(candidate);
  clean.settings.cloudToken = data().settings.cloudToken || '';
  saveData(clean);
  emit('local');
  return { ok: true, error: null };
}

export function clearData() {
  saveData(blankData());
  emit('local');
}
