/* Local-first persistence and credentials.
   Local accounts use salted PBKDF2 (SHA-256) via Web Crypto. Cloud accounts
   keep an encrypted-at-rest bearer token in this browser's localStorage and
   use the same per-user local data cache as an offline-first mirror. */
import { STORAGE, DEFAULT_SYNC_ENDPOINT, CURRENCIES, RETIREMENT_TYPES, RETIREMENT_STATUSES } from './config.js';
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

export function blankData() {
  return {
    settings: {
      currency: 'USD', theme: 'light', name: '', syncEndpoint: '',
      cloudToken: '', linkedMeridian: false, onboardingComplete: false,
    },
    accounts: [],
    transactions: [],
    budgets: [],
    recurring: [],
    goals: [],
    retirementAccounts: [],
    meridian: null,
  };
}

const RETIREMENT_TYPE_VALUES = RETIREMENT_TYPES.map(t => t.value);
const RETIREMENT_STATUS_VALUES = RETIREMENT_STATUSES.map(s => s.value);

function nonnegative(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function percent(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 0;
}

function normalizeRetirementAccount(raw) {
  const row = raw && typeof raw === 'object' ? raw : {};
  return {
    id: String(row.id || ''),
    name: String(row.name || 'Retirement account'),
    type: RETIREMENT_TYPE_VALUES.includes(row.type) ? row.type : 'other',
    institution: String(row.institution || ''),
    owner: String(row.owner || ''),
    accountLast4: String(row.accountLast4 || '').slice(0, 8),
    balance: nonnegative(row.balance),
    employeeYTD: nonnegative(row.employeeYTD),
    employerYTD: nonnegative(row.employerYTD),
    vestedPercent: percent(row.vestedPercent),
    beneficiary: String(row.beneficiary || ''),
    status: RETIREMENT_STATUS_VALUES.includes(row.status) ? row.status : 'active',
    notes: String(row.notes || ''),
    updatedAt: String(row.updatedAt || ''),
  };
}

/* Merge stored / imported / remote objects into a predictable shape. */
export function sanitizeData(input) {
  const base = blankData();
  if (!input || typeof input !== 'object') return base;
  const out = { ...base, ...input, settings: { ...base.settings, ...(input.settings || {}) } };
  ['accounts', 'transactions', 'budgets', 'recurring', 'goals'].forEach(key => {
    out[key] = Array.isArray(input[key]) ? input[key] : [];
  });
  out.retirementAccounts = Array.isArray(input.retirementAccounts)
    ? input.retirementAccounts.map(normalizeRetirementAccount)
    : [];
  out.meridian = input.meridian ?? null;
  if (!out.settings.syncEndpoint) out.settings.syncEndpoint = DEFAULT_SYNC_ENDPOINT;
  if (!out.settings.currency) out.settings.currency = 'USD';
  if (!['light', 'dark'].includes(out.settings.theme)) out.settings.theme = 'light';
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
  delete clean.settings.meridianToken;
  delete clean.settings.syncClientId;
  return JSON.stringify({ app: 'Airo Finance', exportedAt: new Date().toISOString(), data: clean }, null, 2);
}

export function importData(json) {
  const parsed = typeof json === 'string' ? safeParse(json, null) : json;
  const candidate = parsed?.data && typeof parsed.data === 'object' ? parsed.data : parsed;
  if (!candidate || typeof candidate !== 'object' || !Array.isArray(candidate.accounts)) {
    return { ok: false, error: 'That file is not an Airo Finance export.' };
  }
  const clean = sanitizeData(candidate);
  clean.settings.currency = CURRENCIES.includes(candidate.settings?.currency) ? candidate.settings.currency : clean.settings.currency;
  saveData(clean);
  emit('local');
  return { ok: true, error: null };
}

export function clearData() {
  saveData(blankData());
  emit('local');
}
