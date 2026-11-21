/* Local-first accounts and portfolio persistence.
   Passwords are salted + PBKDF2-derived with Web Crypto; data lives in this
   browser only. This is a private local account system, not a cloud service. */
import { STORAGE, DEFAULT_AI_MODEL } from './config.js';
import { SAMPLE_HOLDINGS, SAMPLE_GOALS, INSTRUMENT_MAP } from './data.js';
import { uid, safeParse, seededRandom } from './utils.js';

const ITERATIONS = 120000;

function readJSON(key, fallback) { return safeParse(localStorage.getItem(key), fallback); }
function writeJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}

function toHex(buffer) {
  return [...new Uint8Array(buffer)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function derive(password, saltHex) {
  const bytes = new TextEncoder().encode(password);
  const salt = new Uint8Array(saltHex.match(/.{2}/g).map(h => parseInt(h, 16)));
  const key = await crypto.subtle.importKey('raw', bytes, 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS }, key, 256);
  return toHex(bits);
}

function blankData() {
  return {
    holdings: [], watchlist: [], transactions: [], goals: [],
    settings: { currency: 'USD', theme: 'dark', apiKey: '', name: '', aiModel: DEFAULT_AI_MODEL, onboardingComplete: false },
    createdAt: Date.now(),
  };
}

export function listUsers() { return readJSON(STORAGE.users, []); }

export async function createUser({ name, email, password }) {
  const norm = String(email || '').trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(norm)) return { ok: false, error: 'Enter a valid email address.' };
  if (String(password || '').length < 8) return { ok: false, error: 'Use a password of at least 8 characters.' };
  if (listUsers().some(u => u.email === norm)) return { ok: false, error: 'An account with that email already exists here.' };
  const salt = toHex(crypto.getRandomValues(new Uint8Array(16)));
  const user = { id: uid('usr'), name: String(name || norm.split('@')[0]).trim(), email: norm, salt, hash: await derive(password, salt), createdAt: Date.now() };
  const users = listUsers();
  users.push(user);
  if (!writeJSON(STORAGE.users, users)) return { ok: false, error: 'This browser could not save the account.' };
  writeJSON(STORAGE.dataPrefix + user.id, blankData());
  setSession(user.id);
  return { ok: true, user };
}

export async function signIn(email, password) {
  const norm = String(email || '').trim().toLowerCase();
  const user = listUsers().find(u => u.email === norm);
  if (!user) return { ok: false, error: 'No local account found for that email.' };
  const hash = await derive(password, user.salt);
  if (hash !== user.hash) return { ok: false, error: 'Incorrect password.' };
  setSession(user.id);
  return { ok: true, user };
}

export function setSession(userId) { writeJSON(STORAGE.session, { userId, at: Date.now() }); }

export function currentUser() {
  const session = readJSON(STORAGE.session, null);
  if (!session?.userId) return null;
  const user = listUsers().find(u => u.id === session.userId);
  if (!user) { localStorage.removeItem(STORAGE.session); return null; }
  return user;
}

export function signOut() { localStorage.removeItem(STORAGE.session); }

export function data() {
  const user = currentUser();
  if (!user) return blankData();
  const stored = readJSON(STORAGE.dataPrefix + user.id, null);
  const base = blankData();
  if (!stored) return base;
  return {
    ...base, ...stored,
    settings: { ...base.settings, ...(stored.settings || {}) },
  };
}

export function saveData(next) {
  const user = currentUser();
  if (!user) return false;
  const ok = writeJSON(STORAGE.dataPrefix + user.id, next);
  // Notify optional listeners (e.g. the Meridian Connector) after a real save.
  // Guarded so store.js stays usable outside a browser context.
  if (ok && typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
    window.dispatchEvent(new CustomEvent('meridian:data-changed', { detail: next }));
  }
  return ok;
}

export function updateData(mutator) {
  const next = data();
  const result = mutator(next) ?? next;
  saveData(result);
  return result;
}

export function getPrefs() {
  const globalPrefs = readJSON(STORAGE.prefs, {});
  const user = currentUser();
  const stored = user ? readJSON(STORAGE.dataPrefix + user.id, null) : null;
  const base = {
    currency: 'USD', theme: 'dark', apiKey: '', name: '',
    aiModel: DEFAULT_AI_MODEL, onboardingComplete: false,
  };
  return { ...base, ...globalPrefs, ...(stored?.settings || {}) };
}

export function setPref(key, value) {
  updateData(d => { d.settings[key] = value; });
  const globalPrefs = readJSON(STORAGE.prefs, {});
  if (['apiKey', 'theme', 'aiModel'].includes(key)) {
    globalPrefs[key] = value;
    writeJSON(STORAGE.prefs, globalPrefs);
  }
}

/* Demo account is created on demand and seeded with a diversified sample book. */
export function openDemoAccount() {
  let user = listUsers().find(u => u.email === 'demo@meridian.app');
  if (!user) {
    const salt = toHex(crypto.getRandomValues(new Uint8Array(16)));
    user = { id: uid('usr'), name: 'Demo Investor', email: 'demo@meridian.app', salt, hash: 'demo', createdAt: Date.now() };
    const users = listUsers();
    users.push(user);
    writeJSON(STORAGE.users, users);
  }
  const userData = readJSON(STORAGE.dataPrefix + user.id, null);
  if (!userData) {
    const rand = seededRandom('meridian-demo');
    const holdings = SAMPLE_HOLDINGS.map(h => ({ ...h, id: uid('h'), addedAt: Date.now() - Math.floor(rand() * 400) * 86400000 }));
    const transactions = SAMPLE_HOLDINGS.slice(0, 6).map((h, i) => ({
      id: uid('tx'), symbol: h.symbol, type: 'Buy', quantity: h.quantity, price: h.avgCost,
      date: Date.now() - (30 + i * 45) * 86400000, note: 'Opening position',
    }));
    writeJSON(STORAGE.dataPrefix + user.id, {
      ...blankData(), holdings, transactions,
      watchlist: ['TSLA', 'MSFT', 'QQQ', 'VTI', 'SAP', 'TSM'],
      goals: SAMPLE_GOALS.map(g => ({ ...g, id: uid('goal') })),
      settings: { currency: 'USD', theme: 'dark', apiKey: '', name: 'Demo Investor', aiModel: DEFAULT_AI_MODEL, onboardingComplete: true },
    });
  }
  setSession(user.id);
  return user;
}

export function deleteAccount() {
  const user = currentUser();
  if (!user) return;
  localStorage.removeItem(STORAGE.dataPrefix + user.id);
  writeJSON(STORAGE.users, listUsers().filter(u => u.id !== user.id));
  signOut();
}

export function exportData() {
  return JSON.stringify({ app: 'Meridian Finance', exportedAt: new Date().toISOString(), data: data() }, null, 2);
}

export function importData(json) {
  const parsed = typeof json === 'string' ? safeParse(json, null) : json;
  if (!parsed?.data || !Array.isArray(parsed.data.holdings)) return { ok: false, error: 'That file is not a Meridian export.' };
  const clean = { ...blankData(), ...parsed.data, settings: { ...blankData().settings, ...(parsed.data.settings || {}) } };
  clean.holdings = clean.holdings.filter(h => INSTRUMENT_MAP[h.symbol] || h.symbol);
  return { ok: saveData(clean), error: null };
}

export function resetDemoData() {
  const user = currentUser();
  if (!user) return;
  localStorage.removeItem(STORAGE.dataPrefix + user.id);
  openDemoAccount();
}
