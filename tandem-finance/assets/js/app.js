/* Tandem Finance — view layer, routing and interactions.
   Everything renders from local state; no framework, no bundler. */
import {
  BRAND, ROUTES, PAGE_TITLES, PAGE_SUBTITLES, CURRENCIES, GROUP_KINDS,
  GROUP_EMOJIS, SPLIT_METHODS, EXPENSE_CATEGORIES, CATEGORY_COLORS,
  MEMBER_COLORS, SYNC_APP,
} from './config.js';
import * as store from './store.js';
import { getSyncEndpoint, cloudToken } from './store.js';
import * as api from './api.js';
import { initCalendarWidget } from './calendar-widget.js';
import { donut, bars, columnChart } from './charts.js';
import {
  $, $$, esc, money, roundCents, allocateCents, uid, colorFor,
  memberColor, safeColor, dateInput, dateLabel, initials, debounce, plural,
  monthKey, monthLabel,
} from './utils.js';

const root = $('#app');
const modalHost = $('#modal-host');
const toastHost = $('#toast-host');

const state = {
  authKind: 'signin',
  authBackend: 'auto',
  lastAuth: null,
  cloud: {
    phase: 'checking', available: false, status: 'local', lastSync: null,
    error: '', bannerDismissed: false,
  },
  onboarding: {
    theme: 'cream', currency: 'USD', groupName: '', groupEmoji: '🏠',
    groupKind: 'Household', members: '',
  },
  expenseFilter: { group: 'all', search: '' },
  activityFilter: { group: 'all', type: 'all' },
  balanceGroup: 'all',
  expenseDraft: null,
  settlementDraft: null,
  syncReady: false,
  eventSub: null,
  eventToken: null,
  eventEndpoint: null,
};

/* ------------------------------ basics ------------------------------ */

function route() {
  const hash = (location.hash || '#/').replace(/\/+$/, '') || '#/';
  if (hash.startsWith('#/app/')) {
    const parts = hash.split('/');
    return { mode: 'app', page: parts[2] || 'overview', param: decodeURIComponent(parts[3] || '') };
  }
  if (hash === '#/signin' || hash === '#/login') return { mode: 'auth', kind: 'signin' };
  if (hash === '#/signup') return { mode: 'auth', kind: 'signup' };
  return { mode: 'landing' };
}

function go(hash) {
  if (location.hash === hash) render({ preserveScroll: false });
  else location.hash = hash;
}

function applyTheme() {
  const theme = store.getPrefs().theme === 'plum' ? 'plum' : 'cream';
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'plum' ? '#1b1222' : '#fcf6ee');
}

function currency() { return store.getPrefs().currency || 'USD'; }
function fmt(value, digits) { return money(value, currency(), digits != null ? { digits } : undefined); }
function selected(value, current) { return String(value) === String(current) ? 'selected' : ''; }
function active(value, current) { return String(value) === String(current) ? 'active' : ''; }

function toast(message, type = 'success') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span class="ic">${type === 'error' ? '⚠' : '✓'}</span><span>${esc(message)}</span>`;
  toastHost.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateY(8px)'; }, 3400);
  setTimeout(() => el.remove(), 3800);
}

function openModal(html, wide = false) {
  modalHost.innerHTML = `<div class="overlay" data-action="modal-backdrop"><div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">${html}</div></div>`;
  document.body.style.overflow = 'hidden';
  const first = modalHost.querySelector('input:not([type="hidden"]), select, textarea, button');
  if (first) setTimeout(() => { try { first.focus(); } catch { /* noop */ } }, 40);
}
function closeModal() { modalHost.innerHTML = ''; document.body.style.overflow = ''; }
function modalHead(title, sub = '') {
  return `<div class="modal-head"><div><h2>${esc(title)}</h2>${sub ? `<p>${esc(sub)}</p>` : ''}</div>
    <button type="button" class="btn btn-icon btn-ghost" data-action="modal-close" aria-label="Close">✕</button></div>`;
}
function confirmModal({ title, body, action, id }) {
  openModal(`${modalHead(title)}<p class="muted small">${esc(body)}</p>
    <div class="modal-actions"><button type="button" class="btn" data-action="modal-close">Cancel</button>
    <button type="button" class="btn btn-danger" data-action="${esc(action)}" data-id="${esc(id || '')}">Confirm</button></div>`);
}
function emptyState(icon, title, message, button = '') {
  return `<div class="empty"><div class="big">${icon}</div><h3>${esc(title)}</h3><p>${esc(message)}</p>${button}</div>`;
}

/* ---------------------------- data analysis ---------------------------- */

function groupById(id, d = store.data()) { return d.groups.find(g => g.id === id) || null; }
function memberById(group, id) { return group?.members.find(m => m.id === id) || null; }
function memberName(group, id) { return memberById(group, id)?.name || 'Former member'; }

function myMemberIds(d = store.data()) {
  const user = store.currentUser() || {};
  const me = String(d.settings.name || user.name || '').trim().toLowerCase();
  const email = String(user.email || '').toLowerCase();
  const ids = [];
  d.groups.forEach(g => g.members.forEach(m => {
    const name = String(m.name || '').toLowerCase();
    const mail = String(m.email || '').toLowerCase();
    if ((me && name === me) || (email && mail === email) || name === 'you' || name === 'me') ids.push(m.id);
  }));
  return ids;
}

/* Resolve the cents each member owes for one expense. Stored share weights are
   interpreted by split method; the result always adds up to the total. */
function splitAmounts(expense, group) {
  const out = {};
  const members = group?.members || [];
  if (!members.length) return out;
  const total = Math.max(0, roundCents(expense?.amount));
  if (expense?.split === 'custom') {
    const cents = members.map(m => {
      const raw = expense.custom?.[m.id] ?? expense.shares?.[m.id] ?? 0;
      return Math.max(0, Math.round((Number(raw) || 0) * 100));
    });
    let diff = Math.round(total * 100) - cents.reduce((a, b) => a + b, 0);
    if (diff !== 0 && cents.length) cents[cents.length - 1] = Math.max(0, cents[cents.length - 1] + diff);
    members.forEach((m, i) => { out[m.id] = cents[i] / 100; });
    return out;
  }
  const weights = members.map(m => {
    const raw = expense?.split === 'shares' ? (expense.shares?.[m.id] ?? 1) : 1;
    return Math.max(0, Number(raw) || 0);
  });
  const parts = allocateCents(total, weights);
  members.forEach((m, i) => { out[m.id] = parts[i] || 0; });
  return out;
}

/* Positive net means the member is owed money; negative means they owe. */
function netFor(d, groupId) {
  const group = groupById(groupId, d);
  const net = {};
  if (!group) return net;
  group.members.forEach(m => { net[m.id] = 0; });
  const add = (id, value) => { if (id in net) net[id] = roundCents(net[id] + value); };
  d.expenses.filter(e => e.groupId === groupId).forEach(e => {
    const parts = splitAmounts(e, group);
    group.members.forEach(m => add(m.id, -(parts[m.id] || 0)));
    add(e.payerId, roundCents(e.amount));
  });
  d.settlements.filter(s => s.groupId === groupId).forEach(s => {
    add(s.fromId, roundCents(s.amount));
    add(s.toId, -roundCents(s.amount));
  });
  return net;
}

/* Greedy largest debtor / largest creditor matching: fewest payments needed. */
function settleSuggestions(net, group) {
  const debtors = Object.entries(net).filter(([, v]) => v < -0.004)
    .map(([id, v]) => ({ id, amount: roundCents(-v) }))
    .sort((a, b) => (b.amount - a.amount) || a.id.localeCompare(b.id));
  const creditors = Object.entries(net).filter(([, v]) => v > 0.004)
    .map(([id, v]) => ({ id, amount: roundCents(v) }))
    .sort((a, b) => (b.amount - a.amount) || a.id.localeCompare(b.id));
  const out = [];
  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const amount = roundCents(Math.min(debtors[i].amount, creditors[j].amount));
    if (amount > 0.004) out.push({ fromId: debtors[i].id, toId: creditors[j].id, amount });
    debtors[i].amount = roundCents(debtors[i].amount - amount);
    creditors[j].amount = roundCents(creditors[j].amount - amount);
    if (debtors[i].amount <= 0.004) i++;
    if (creditors[j].amount <= 0.004) j++;
  }
  return out;
}

function allSuggestions(d, groupId = 'all') {
  const out = [];
  d.groups.filter(g => groupId === 'all' || g.id === groupId).forEach(g => {
    settleSuggestions(netFor(d, g.id), g).forEach(s => out.push({ ...s, groupId: g.id, group: g }));
  });
  return out;
}

function stats(d = store.data()) {
  let outstanding = 0, myNet = 0, settled = 0, totalSpent = 0;
  const mine = new Set(myMemberIds(d));
  d.groups.forEach(g => {
    const net = netFor(d, g.id);
    Object.values(net).forEach(v => { if (v > 0) outstanding += v; });
    mine.forEach(id => { if (id in net) myNet += net[id]; });
  });
  d.settlements.forEach(s => { settled += Math.abs(Number(s.amount) || 0); });
  d.expenses.forEach(e => { totalSpent += Math.abs(Number(e.amount) || 0); });
  return {
    outstanding: roundCents(outstanding), myNet: roundCents(myNet),
    settled: roundCents(settled), totalSpent: roundCents(totalSpent),
    groups: d.groups.length, expenses: d.expenses.length,
    members: d.groups.reduce((n, g) => n + g.members.length, 0),
    avg: d.expenses.length ? roundCents(totalSpent / d.expenses.length) : 0,
  };
}

function activityItems(d = store.data(), filter = null) {
  const items = [];
  d.expenses.forEach(e => {
    const g = groupById(e.groupId, d);
    items.push({
      id: e.id, type: 'expense', groupId: e.groupId,
      groupName: g?.name || 'Unknown group', date: e.date,
      title: e.title || 'Expense', amount: roundCents(e.amount),
      person: memberName(g, e.payerId), target: '',
      category: e.category || 'Other', note: e.note || '',
    });
  });
  d.settlements.forEach(s => {
    const g = groupById(s.groupId, d);
    items.push({
      id: s.id, type: 'settlement', groupId: s.groupId,
      groupName: g?.name || 'Unknown group', date: s.date,
      title: 'Settlement', amount: roundCents(s.amount),
      person: memberName(g, s.fromId), target: memberName(g, s.toId),
      category: 'Settlement', note: s.note || '',
    });
  });
  items.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || a.id.localeCompare(b.id));
  if (!filter) return items;
  return items.filter(i => {
    if (filter.group && filter.group !== 'all' && i.groupId !== filter.group) return false;
    if (filter.type && filter.type !== 'all' && i.type !== filter.type) return false;
    return true;
  });
}

function insightsFor(d = store.data()) {
  const s = stats(d);
  const paid = {}, byCat = {}, byGroup = {};
  d.expenses.forEach(e => {
    const g = groupById(e.groupId, d);
    const payer = memberName(g, e.payerId);
    paid[payer] = (paid[payer] || 0) + (Number(e.amount) || 0);
    const cat = e.category || 'Other';
    byCat[cat] = (byCat[cat] || 0) + (Number(e.amount) || 0);
    byGroup[e.groupId] = (byGroup[e.groupId] || 0) + 1;
  });
  const topPayer = Object.entries(paid).sort((a, b) => b[1] - a[1])[0] || null;
  const topCategory = Object.entries(byCat).sort((a, b) => b[1] - a[1])[0] || null;
  const busiestId = Object.entries(byGroup).sort((a, b) => b[1] - a[1])[0]?.[0];
  const busiest = busiestId ? groupById(busiestId, d) : null;
  const busiestCount = busiestId ? byGroup[busiestId] : 0;
  const categorySegments = Object.entries(byCat).sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map(([label, value]) => ({ label, value: roundCents(value), color: colorFor(label, CATEGORY_COLORS) }));
  const monthly = [];
  const base = new Date();
  for (let i = 5; i >= 0; i--) {
    const key = monthKey(new Date(base.getFullYear(), base.getMonth() - i, 1));
    const value = d.expenses.filter(e => String(e.date || '').slice(0, 7) === key)
      .reduce((sum, e) => sum + (Number(e.amount) || 0), 0);
    monthly.push({ label: monthLabel(key), value: roundCents(value), display: fmt(value, 0) });
  }
  return { s, topPayer, topCategory, busiest, busiestCount, categorySegments, monthly };
}

/* --------------------------- cloud sync engine --------------------------- */

function statusInfo() {
  if (store.authMode() === 'cloud' && state.cloud.status === 'live') return { cls: 'live', text: 'Cloud live', badge: 'Live' };
  if (state.cloud.status === 'connecting') return { cls: 'connecting', text: 'Connecting…', badge: 'Connecting' };
  if (state.cloud.status === 'offline') return { cls: 'offline', text: 'Cloud offline', badge: 'Local' };
  return { cls: 'local', text: 'Local-only', badge: 'Local' };
}

function paintSyncStatus() {
  const info = statusInfo();
  $$('[data-sync-status]').forEach(el => {
    el.textContent = info.text;
    const pill = el.closest('.status-pill');
    if (pill) pill.className = `status-pill ${info.cls}`;
  });
  $$('[data-sync-badge]').forEach(el => {
    el.textContent = info.badge;
    el.className = `badge ${info.cls === 'live' ? 'live' : info.cls === 'offline' ? 'warn' : 'neutral'}`;
  });
  const time = state.cloud.lastSync ? `Synced ${dateLabel(state.cloud.lastSync, { relative: true })}` : 'Not synced yet';
  $$('[data-sync-time]').forEach(el => { el.textContent = time; });
}

function readRemoteData(res) {
  if (!res.ok || !res.data || typeof res.data !== 'object') return null;
  const body = res.data.data && typeof res.data.data === 'object' ? res.data.data : null;
  return {
    body, updatedAt: Date.parse(res.data.updatedAt) || 0,
    clientId: String(res.data.clientId || ''),
  };
}

async function checkCloud({ silent = false } = {}) {
  const res = await api.health();
  state.cloud.phase = res.ok ? 'online' : 'offline';
  state.cloud.available = !!res.ok;
  state.cloud.error = res.ok ? '' : (res.error || 'Cloud endpoint unavailable.');
  if (!res.ok) state.cloud.status = 'offline';
  else if (store.authMode() === 'cloud' && state.cloud.status !== 'live') state.cloud.status = 'connecting';
  paintSyncStatus();
  if (!silent) render({ preserveScroll: true });
  return !!res.ok;
}

async function hydrateCloud() {
  const token = store.cloudToken();
  if (!token || state.cloud.phase !== 'online') return;
  const remote = readRemoteData(await api.getSnapshot(SYNC_APP, token));
  if (!remote?.body) return;
  const meta = store.getSyncMeta();
  const isOwnWrite = remote.clientId === store.clientId();
  if (!isOwnWrite && (remote.updatedAt > (meta.remoteAt || 0) || !store.getPrefs().onboardingComplete)) {
    const clean = store.sanitizeData(remote.body);
    clean.settings.cloudToken = token;
    store.replaceData(clean, 'remote');
  }
  store.setSyncMeta({ remoteAt: Math.max(remote.updatedAt, meta.remoteAt || 0), lastSync: Date.now() });
  state.cloud.lastSync = Date.now();
  paintSyncStatus();
}

async function pushSnapshotNow(payload) {
  const token = store.cloudToken();
  if (!token || state.cloud.phase !== 'online') return;
  const clean = store.sanitizeData(payload || store.data());
  clean.settings.cloudToken = '';
  const res = await api.putSnapshot(SYNC_APP, clean, token, store.clientId());
  if (res.ok) {
    const at = Date.parse(res.data?.updatedAt) || Date.now();
    store.setSyncMeta({ remoteAt: at, lastSync: Date.now() });
    state.cloud.lastSync = Date.now();
    state.cloud.status = 'live';
  } else if (res.status === 401) {
    state.cloud.status = 'offline';
    toast('Cloud session expired. Sign in again to resume sync.', 'error');
  } else {
    state.cloud.status = 'offline';
  }
  paintSyncStatus();
}

const schedulePush = debounce(data => pushSnapshotNow(data), 1100);

function stopEvents() {
  try { state.eventSub?.close(); } catch { /* noop */ }
  state.eventSub = null;
  state.eventToken = null;
  state.eventEndpoint = null;
}

function startEvents() {
  stopEvents();
  const token = store.cloudToken();
  const endpoint = store.getSyncEndpoint();
  if (!token || state.cloud.phase !== 'online') return;
  state.eventToken = token;
  state.eventEndpoint = endpoint;
  state.eventSub = api.subscribeEvents({
    token, endpoint,
    onStatus: status => {
      if (status === 'live') state.cloud.status = 'live';
      else if (status === 'connecting') state.cloud.status = 'connecting';
      else state.cloud.status = 'offline';
      paintSyncStatus();
    },
    onSnapshot: handleStreamEvent,
  });
}

function syncEventsForCurrentConfig() {
  const token = store.cloudToken();
  const endpoint = store.getSyncEndpoint();
  if (!token || state.cloud.phase !== 'online') {
    if (state.eventSub) stopEvents();
    return;
  }
  if (token !== state.eventToken || endpoint !== state.eventEndpoint) startEvents();
}

async function handleStreamEvent(payload) {
  try {
    if (payload.app && payload.app !== SYNC_APP) return;
    if (payload.clientId && payload.clientId === store.clientId()) return;
    const remote = readRemoteData(await api.getSnapshot(SYNC_APP));
    if (!remote?.body) return;
    const meta = store.getSyncMeta();
    if (remote.clientId === store.clientId() || remote.updatedAt <= (meta.remoteAt || 0)) {
      store.setSyncMeta({ remoteAt: Math.max(remote.updatedAt, meta.remoteAt || 0), lastSync: Date.now() });
      state.cloud.lastSync = Date.now();
      paintSyncStatus();
      return;
    }
    const clean = store.sanitizeData(remote.body);
    clean.settings.cloudToken = store.cloudToken();
    store.setSyncMeta({ remoteAt: remote.updatedAt, lastSync: Date.now() });
    store.replaceData(clean, 'remote');
    state.cloud.lastSync = Date.now();
    paintSyncStatus();
    render({ preserveScroll: true });
    toast('Latest changes loaded from cloud.');
  } catch { /* stream events are best-effort */ }
}

store.subscribe((data, meta) => {
  if (meta.source === 'local' && state.syncReady) schedulePush(data);
  if (store.authMode() === 'cloud') syncEventsForCurrentConfig();
  else if (state.eventSub) stopEvents();
});

/* ------------------------------- landing ------------------------------- */

function brandMarkup(small = false) {
  return `<span class="brand"><span class="brand-mark">T</span><span class="brand-name">${esc(BRAND.product)}${small ? '' : `<span class="brand-sub">by ${esc(BRAND.legal)}</span>`}</span></span>`;
}

function landing() {
  const curve = 'M4,118 C60,112 88,80 132,92 C176,104 198,64 242,74 C286,84 308,44 352,52 C396,60 420,26 460,32 C484,36 496,20 508,14';
  return `<div class="landing">
    <div class="nav-wrap"><nav class="nav">
      ${brandMarkup()}
      <div class="nav-links"><a href="#features">Features</a><a href="#how">How it works</a><a href="#privacy">Privacy</a></div>
      <div class="nav-actions">
        <button class="btn btn-icon btn-ghost" data-action="toggle-theme" title="Toggle theme">${store.getPrefs().theme === 'cream' ? '◐' : '☀'}</button>
        <a class="btn btn-ghost btn-sm" href="${ROUTES.signin}">Sign in</a>
        <a class="btn btn-primary btn-sm" href="${ROUTES.signup}">Get started →</a>
      </div>
    </nav></div>

    <header class="hero">
      <div>
        <span class="eyebrow"><span class="pulse-dot"></span> A product of ${esc(BRAND.legal)}</span>
        <h1>Shared money, <em>simple.</em></h1>
        <p class="hero-copy">Split the grocery run, the rental car and the whole trip with people you trust. Tandem keeps every shared expense, IOU and settlement in one friendly place — with no bank logins and no awkward spreadsheet.</p>
        <div class="hero-ctas">
          <a class="btn btn-primary btn-lg" href="${ROUTES.signup}">Start sharing →</a>
          <a class="btn btn-lg" href="${ROUTES.signin}">I already have an account</a>
        </div>
        <div class="hero-note"><span>✓ Manual expenses</span><span>✓ No bank logins</span><span>✓ Optional cloud sync</span></div>
      </div>
      <div class="hero-visual">
        <div class="hero-glow"></div>
        <div class="mock-card">
          <div class="mock-top"><span>Weekend in Lisbon · Trip</span><span class="tag-pill">4 people</span></div>
          <div class="mock-label">Total shared</div>
          <div class="mock-value">$486.20</div>
          <div class="mock-change">3 expenses · 1 settlement this week</div>
          <div class="mock-chart">
            <svg viewBox="0 0 512 140" preserveAspectRatio="none" aria-hidden="true">
              <defs><linearGradient id="tandemMock" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#e9685a" stop-opacity=".3"/><stop offset="100%" stop-color="#e9685a" stop-opacity="0"/></linearGradient></defs>
              <path d="${curve} L508,140 L4,140 Z" fill="url(#tandemMock)"/>
              <path d="${curve}" fill="none" stroke="#e9685a" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </div>
          <div class="mock-rows">
            <div class="mock-row"><span class="sym">🧾 Dinner by the river</span><b>$128.00 / 4</b></div>
            <div class="mock-row"><span class="sym">🚗 Airport transfer</span><b>$72.50 / 4</b></div>
            <div class="mock-row"><span class="sym owe">↗ Sam → You</span><b>$41.25</b></div>
          </div>
        </div>
        <div class="float-chip one"><span class="dot"></span> All settled up</div>
        <div class="float-chip two">◈ No bank connection needed</div>
      </div>
    </header>

    <div class="ticker-band"><div class="ticker-track">
      ${['SHARED EXPENSES', 'SPLIT BILLS', 'IOUS', 'SETTLE UP', 'HOUSEHOLDS', 'TRIPS', 'EVENTS'].map(x => `<span class="ticker-item"><b>✦</b>${x}</span>`).join('')}
      ${['SHARED EXPENSES', 'SPLIT BILLS', 'IOUS', 'SETTLE UP', 'HOUSEHOLDS', 'TRIPS', 'EVENTS'].map(x => `<span class="ticker-item"><b>✦</b>${x}</span>`).join('')}
    </div></div>

    <section class="section" id="features">
      <div class="section-head"><span class="eyebrow">Made for togetherness</span>
        <h2>Everything shared, nothing awkward.</h2>
        <p>Tandem does the arithmetic, keeps the history, and tells you exactly who still owes what. You just enjoy the dinner.</p>
      </div>
      <div class="feature-grid">
        <article class="feature"><div class="feature-icon">◎</div><h3>Groups for everything</h3><p>Household, weekend trip, concert night or wedding — make a group with the people who share the cost.</p></article>
        <article class="feature"><div class="feature-icon">÷</div><h3>Split your way</h3><p>Divide equally, by custom shares, or type exact amounts. Tandem checks that every cent adds up.</p></article>
        <article class="feature"><div class="feature-icon">⚖</div><h3>Know who owes whom</h3><p>Simplified balances turn a tangle of expenses into a short, fair settle-up plan for the whole group.</p></article>
        <article class="feature"><div class="feature-icon">↗</div><h3>Settle in a tap</h3><p>Record a payment between members and watch the debt disappear from every balance in that group.</p></article>
        <article class="feature"><div class="feature-icon">◷</div><h3>A shared timeline</h3><p>Every expense and settlement lands in one chronological feed, with notes, categories and receipts by memory.</p></article>
        <article class="feature"><div class="feature-icon">♡</div><h3>Private by default</h3><p>Local accounts use salted PBKDF2 hashing. Cloud sync is optional, and there is never a bank login here.</p></article>
      </div>
    </section>

    <section class="section" id="how" style="padding-top:0">
      <div class="split-section">
        <div>
          <span class="eyebrow">Honest by design</span>
          <h2>No bank credentials. No OAuth. Just the numbers you enter.</h2>
          <p class="muted" style="margin-top:16px">Tandem is a manual companion for shared money. You record what was paid and how it splits; we handle the balances. Nothing here connects to a bank, stores a bank password, or pulls your transactions in the background.</p>
          <div class="asset-cloud"><span class="asset-chip"><b>Household</b></span><span class="asset-chip"><b>Group trips</b></span><span class="asset-chip"><b>Events</b></span><span class="asset-chip"><b>IOUs</b></span><span class="asset-chip"><b>Settlements</b></span></div>
        </div>
        <div class="card">
          <div class="card-head"><h3>How it works</h3><span class="tag-pill">3 steps</span></div>
          <div class="step-list">
            <div class="step"><b>1</b><div><strong>Make a group</strong><p>Name it, pick an emoji, and add the people who share the cost.</p></div></div>
            <div class="step"><b>2</b><div><strong>Log an expense</strong><p>Who paid, how much, and whether it splits equally or by custom amounts.</p></div></div>
            <div class="step"><b>3</b><div><strong>Settle up</strong><p>Follow the shortest plan, record the payment, and see balances return to zero.</p></div></div>
          </div>
        </div>
      </div>
    </section>

    <section class="section" id="privacy" style="padding-top:0">
      <div class="cta-band">
        <span class="eyebrow">Ready when you are</span>
        <h2>${esc(BRAND.tagline)}</h2>
        <p>Start with one group and one shared bill. Everything else can wait.</p>
        <div class="btn-row" style="justify-content:center">
          <a class="btn btn-primary btn-lg" href="${ROUTES.signup}">Create your first group →</a>
          <a class="btn btn-lg" href="${ROUTES.signin}">Sign in</a>
        </div>
      </div>
    </section>

    <footer class="landing-footer"><div class="footer-inner">
      <div>${brandMarkup()}<p><b>Made by ${esc(BRAND.legal)}.</b> ${esc(BRAND.dba)} is a trade name of ${esc(BRAND.legal)}. Manual shared expenses only — bank login and account aggregation are not enabled. Informational only; not financial advice.</p></div>
      <div class="footer-links"><a href="#features">Features</a><a href="#how">How it works</a><a href="#privacy">Privacy</a><a href="${ROUTES.signin}">Sign in</a><a href="${ROUTES.signup}">Get started</a></div>
    </div></footer>
  </div>`;
}

/* --------------------------------- auth --------------------------------- */

function effectiveBackend() {
  if (state.authBackend !== 'auto') return state.authBackend;
  return state.cloud.available ? 'cloud' : 'local';
}

function authView(kind) {
  const backend = effectiveBackend();
  const available = state.cloud.phase === 'online';
  const isSignup = kind === 'signup';
  const modeChip = `<div class="mode-chip ${available ? '' : 'offline'}">
    <span class="dot"></span>
    <span class="txt"><b>${backend === 'cloud' ? 'Cloud account' : 'Browser account'}</b>
      <span>${backend === 'cloud' ? 'Syncs through Atlas Sync when reachable.' : 'Stored only in this browser with PBKDF2 hashing.'}</span></span>
    <span class="mode-switch">
      <button type="button" class="${backend === 'cloud' ? 'active' : ''}" data-action="set-auth-backend" data-backend="cloud" ${available ? '' : 'disabled title="Cloud endpoint unavailable"'}>Cloud</button>
      <button type="button" class="${backend === 'local' ? 'active' : ''}" data-action="set-auth-backend" data-backend="local">Browser</button>
    </span>
  </div>`;

  return `<div class="auth-page">
    <div class="auth-form-side"><div class="auth-box">
      <a href="${ROUTES.landing}">${brandMarkup()}</a>
      <h1 style="margin-top:28px">${isSignup ? 'Make money shared' : 'Welcome back'}</h1>
      <p class="sub">${isSignup ? 'Two minutes to your first group.' : 'Sign in to pick up where you left off.'}</p>
      ${modeChip}
      <form id="${isSignup ? 'signup-form' : 'signin-form'}" autocomplete="on">
        ${isSignup ? `<div class="field"><label for="auth-name">Your name</label><input class="input" id="auth-name" name="name" autocomplete="name" placeholder="Alex Morgan" required/></div>` : ''}
        <div class="field"><label for="auth-email">Email address</label><input class="input" id="auth-email" name="email" type="email" autocomplete="email" placeholder="you@example.com" required/></div>
        <div class="field"><label for="auth-password">Password</label><input class="input" id="auth-password" name="password" type="password" autocomplete="${isSignup ? 'new-password' : 'current-password'}" placeholder="At least 8 characters" required/></div>
        <div class="form-error" id="auth-error"></div>
        <button class="btn btn-primary btn-lg" type="submit" style="width:100%">${isSignup ? 'Create account →' : 'Sign in →'}</button>
      </form>
      <div class="auth-switch">${isSignup ? 'Already have an account? ' : 'New to Tandem? '}
        <a href="${isSignup ? ROUTES.signin : ROUTES.signup}">${isSignup ? 'Sign in' : 'Create one'}</a></div>
      <p class="data-note">${available ? 'Cloud endpoint reachable.' : `Cloud endpoint unavailable — using browser mode. <button type="button" class="btn btn-sm btn-ghost" data-action="retry-cloud">Retry</button>`}</p>
    </div></div>
    <div class="auth-art">
      <span class="eyebrow">${esc(BRAND.dba)}</span>
      <h2>${esc(BRAND.tagline)}</h2>
      <p>One calm place for the bills you share, the people you share them with, and the clean slate at the end.</p>
      <div class="auth-points">
        <div class="auth-point"><span style="color:var(--amber)">✓</span><span>Groups, expenses and IOUs that always add up.</span></div>
        <div class="auth-point"><span style="color:var(--amber)">✓</span><span>Fair, simplified settle-up suggestions.</span></div>
        <div class="auth-point"><span style="color:var(--amber)">✓</span><span>No bank credentials, no OAuth, no aggregation.</span></div>
      </div>
    </div>
  </div>`;
}

function prepareOnboarding(message) {
  const user = store.currentUser() || {};
  state.onboarding = {
    theme: store.getPrefs().theme === 'plum' ? 'plum' : 'cream',
    currency: store.getPrefs().currency || 'USD',
    groupName: 'Household',
    groupEmoji: '🏠',
    groupKind: 'Household',
    members: [user.name || 'You', 'Jamie', 'Riley'].join(', '),
  };
  if (message) toast(message);
  onboardingModal();
}

async function performAuth(kind, backend) {
  const fields = state.lastAuth;
  if (!fields) return;
  const errorEl = $('#auth-error');
  const setError = (msg, fallback = false) => {
    if (errorEl) errorEl.innerHTML = `${esc(msg)}${fallback ? ` <button type="button" class="btn btn-sm" data-action="auth-fallback-local">Use this browser instead</button>` : ''}`;
  };
  if (errorEl) errorEl.textContent = '';
  const submit = document.querySelector('#signin-form button[type=submit], #signup-form button[type=submit]');
  if (submit) submit.disabled = true;
  try {
    if (backend === 'cloud') {
      const res = kind === 'signup'
        ? await api.signup({ email: fields.email, name: fields.name, password: fields.password })
        : await api.login({ email: fields.email, password: fields.password });
      if (!res.ok || !res.data?.token) { setError(res.error || 'Cloud sign-in failed.', true); return; }
      state.syncReady = false;
      store.setCloudSession({ token: res.data.token, user: res.data.user, endpoint: store.getSyncEndpoint() });
      state.cloud.phase = 'online';
      state.cloud.available = true;
      await hydrateCloud();
      state.syncReady = true;
      syncEventsForCurrentConfig();
      state.cloud.status = 'live';
      paintSyncStatus();
    } else {
      const res = kind === 'signup'
        ? await store.createUser(fields)
        : await store.signIn(fields.email, fields.password);
      if (!res.ok) { setError(res.error || 'Sign-in failed.'); return; }
      state.cloud.status = state.cloud.phase === 'offline' ? 'offline' : 'local';
      paintSyncStatus();
    }
    const user = store.currentUser();
    if (kind === 'signup' || !store.getPrefs().onboardingComplete) {
      prepareOnboarding(kind === 'signup' ? 'Account created. Let’s set up Tandem.' : 'Welcome back — finish setup to continue.');
      return;
    }
    toast(`Welcome back, ${user?.name || 'there'}.`);
    go(ROUTES.overview);
  } finally {
    if (submit) submit.disabled = false;
  }
}

function readOnboardFields() {
  const map = {
    'on-currency': 'currency', 'on-group-name': 'groupName', 'on-group-emoji': 'groupEmoji',
    'on-group-kind': 'groupKind', 'on-members': 'members',
  };
  Object.entries(map).forEach(([id, key]) => { const el = $(`#${id}`); if (el) state.onboarding[key] = el.value; });
}

function onboardingModal() {
  const o = state.onboarding;
  openModal(`<div class="onboarding-head"><span class="eyebrow">First steps</span>
    <h2 style="font-size:26px;margin-top:12px">Make Tandem yours</h2>
    <p class="muted small" style="margin-top:6px">Three quick choices. You can change all of them later in Settings.</p></div>
    <form id="onboarding-form">
      <div class="onboard-section">
        <div class="onboard-label"><b>1</b><span>Choose a theme</span></div>
        <div class="theme-choices">
          <button type="button" class="theme-choice ${active(o.theme, 'cream')}" data-action="onboard-theme" data-theme="cream">
            <span class="theme-preview cream"><i></i><i></i><i></i></span><span class="theme-icon">☀</span>
            <strong>Cream</strong><small>Warm, bright and easy on the eyes.</small></button>
          <button type="button" class="theme-choice ${active(o.theme, 'plum')}" data-action="onboard-theme" data-theme="plum">
            <span class="theme-preview plum"><i></i><i></i><i></i></span><span class="theme-icon">◐</span>
            <strong>Plum</strong><small>Deep plum with cozy coral contrast.</small></button>
        </div>
      </div>
      <div class="onboard-section">
        <div class="onboard-label"><b>2</b><span>Base currency</span></div>
        <div class="field"><label for="on-currency">Display currency for all amounts</label>
          <select class="input" id="on-currency">${CURRENCIES.map(c => `<option value="${esc(c)}" ${selected(c, o.currency)}>${esc(c)}</option>`).join('')}</select></div>
      </div>
      <div class="onboard-section">
        <div class="onboard-label"><b>3</b><span>Create your first group</span></div>
        <div class="form-grid">
          <div class="field"><label for="on-group-name">Group name</label><input class="input" id="on-group-name" value="${esc(o.groupName)}" placeholder="Household" required/></div>
          <div class="field"><label for="on-group-kind">What is it?</label><select class="input" id="on-group-kind">${GROUP_KINDS.map(k => `<option value="${esc(k)}" ${selected(k, o.groupKind)}>${esc(k)}</option>`).join('')}</select></div>
        </div>
        <div class="field"><label for="on-group-emoji">Emoji</label><select class="input" id="on-group-emoji">${GROUP_EMOJIS.map(e => `<option value="${esc(e)}" ${selected(e, o.groupEmoji)}>${esc(e)}</option>`).join('')}</select></div>
        <div class="field"><label for="on-members">Members (comma separated)</label><input class="input" id="on-members" value="${esc(o.members)}" placeholder="You, Jamie, Riley" required/>
          <span class="field-hint">The first name is treated as you. Add up to 8 people — you can add more later.</span></div>
      </div>
      <div class="modal-actions"><button class="btn btn-primary" type="submit">Open my workspace →</button></div>
    </form>`);
}

function finishOnboarding() {
  readOnboardFields();
  const o = state.onboarding;
  const names = String(o.members || '').split(',').map(n => n.trim()).filter(Boolean).slice(0, 8);
  if (!String(o.groupName || '').trim() || !names.length) {
    toast('Give the group a name and at least one member.', 'error');
    return;
  }
  const user = store.currentUser() || {};
  store.updateData(d => {
    d.settings.theme = o.theme === 'plum' ? 'plum' : 'cream';
    d.settings.currency = CURRENCIES.includes(o.currency) ? o.currency : 'USD';
    d.settings.name = names[0] || d.settings.name || user.name || '';
    d.settings.onboardingComplete = true;
    d.groups.push({
      id: uid('grp'), name: String(o.groupName).trim(), emoji: o.groupEmoji || '🧾',
      kind: GROUP_KINDS.includes(o.groupKind) ? o.groupKind : 'Other',
      members: names.map((name, i) => ({
        id: uid('mem'), name, email: i === 0 ? String(user.email || '') : '',
        color: MEMBER_COLORS[i % MEMBER_COLORS.length],
      })),
      createdAt: Date.now(),
    });
  });
  closeModal();
  applyTheme();
  toast('You’re all set.');
  go(ROUTES.overview);
}

/* -------------------------------- shell -------------------------------- */

function navItem(page, icon, label) {
  const r = route();
  const isActive = r.mode === 'app' && r.page === page;
  return `<a class="nav-item ${isActive ? 'active' : ''}" href="#/app/${page}" title="${esc(label)}"><span class="ico">${icon}</span><span class="label">${esc(label)}</span></a>`;
}

function sidebar() {
  const user = store.currentUser() || {};
  return `<aside class="sidebar">
    ${brandMarkup(true)}
    <div><p class="nav-group-label">Your space</p><nav class="side-nav">
      ${navItem('overview', '◫', 'Overview')}
      ${navItem('groups', '◎', 'Groups')}
      ${navItem('expenses', '🧾', 'Expenses')}
    </nav></div>
    <div><p class="nav-group-label">Keep it clear</p><nav class="side-nav">
      ${navItem('balances', '⚖', 'Balances')}
      ${navItem('activity', '◷', 'Activity')}
      ${navItem('settings', '⚙', 'Settings')}
    </nav></div>
    <div class="sidebar-bottom">
      <div class="side-account"><span class="avatar">${esc(initials(user.name || store.getPrefs().name || 'Tandem user'))}</span>
        <span class="details"><span class="name">${esc(user.name || store.getPrefs().name || 'Tandem user')}</span><span class="mail">${esc(user.email || '')}</span></span></div>
      <p class="side-note">${esc(BRAND.dba)} · Made by ${esc(BRAND.legal)}. Manual shared expenses only.</p>
    </div>
  </aside>`;
}

function topbar(page) {
  const info = statusInfo();
  return `<header class="topbar">
    <button class="btn btn-icon btn-ghost mobile-menu" data-action="toggle-mobile-nav" title="Navigation">☰</button>
    <div class="page-title"><h1>${esc(PAGE_TITLES[page] || 'Overview')}</h1><p>${esc(PAGE_SUBTITLES[page] || BRAND.tagline)}</p></div>
    <div class="topbar-right">
      <div class="status-pill ${info.cls}" title="Cloud sync status"><span class="status-dot"></span><span class="status-text" data-sync-status>${esc(info.text)}</span></div>
      <button class="btn btn-icon btn-ghost" data-action="toggle-theme" title="Toggle theme">${store.getPrefs().theme === 'cream' ? '◐' : '☀'}</button>
      <button class="btn btn-primary btn-sm" data-action="add-expense">＋ Add expense</button>
    </div>
  </header>`;
}

function bannerMarkup() {
  if (state.cloud.phase !== 'offline' || state.cloud.bannerDismissed) return '';
  return `<div class="banner"><span class="ic">⚠</span>
    <span class="txt"><b>Cloud sync is unavailable.</b> Tandem is working in local-only mode — your data stays in this browser. ${esc(state.cloud.error || '')}</span>
    <button class="btn btn-sm" data-action="retry-cloud">Retry</button>
    <button class="btn btn-sm btn-ghost" data-action="dismiss-banner">Dismiss</button></div>`;
}

function pageHead(title, subtitle, button = '') {
  return `<div class="page-head"><div><h1>${esc(title)}</h1><p>${esc(subtitle)}</p></div>${button}</div>`;
}

function memberAvatar(m, extraClass = '') {
  const color = safeColor(m?.color, memberColor(m?.name || '?'));
  return `<span class="member-avatar ${extraClass}" style="background:${color}" title="${esc(m?.name || 'Member')}">${esc(initials(m?.name || '?'))}</span>`;
}

function memberChip(group, memberId, amount) {
  const m = memberById(group, memberId);
  const color = safeColor(m?.color, memberColor(m?.name || '?'));
  return `<span class="member-chip"><span class="chip-dot" style="background:${color}"></span><span>${esc(memberName(group, memberId))}</span><b>${esc(fmt(amount))}</b></span>`;
}

function activityList(items, d, { compact = false } = {}) {
  if (!items.length) return emptyState('◷', 'Nothing here yet', 'Expenses and settlements will show up in this timeline.');
  return `<div class="feed">${items.map(i => {
    const isExpense = i.type === 'expense';
    return `<div class="feed-item">
      <span class="feed-icon ${isExpense ? 'expense' : 'settlement'}">${isExpense ? '🧾' : '↗'}</span>
      <div class="feed-body">
        <div class="feed-line"><strong>${esc(i.title)}</strong><span class="badge ${isExpense ? 'neutral' : 'live'}">${isExpense ? 'Expense' : 'Settled'}</span></div>
        <div class="feed-meta">${esc(i.person)}${i.target ? ` → ${esc(i.target)}` : ''} · ${esc(i.groupName)} · ${esc(dateLabel(i.date, { short: true }))}</div>
        ${!compact && i.note ? `<div class="feed-note">${esc(i.note)}</div>` : ''}
      </div>
      <div class="feed-amount">${esc(fmt(i.amount))}</div>
    </div>`;
  }).join('')}</div>`;
}

function groupCard(g, d) {
  const net = netFor(d, g.id);
  const mine = new Set(myMemberIds(d));
  let my = 0;
  Object.entries(net).forEach(([id, v]) => { if (mine.has(id)) my += v; });
  my = roundCents(my);
  const spent = d.expenses.filter(e => e.groupId === g.id).reduce((n, e) => n + (Number(e.amount) || 0), 0);
  const count = d.expenses.filter(e => e.groupId === g.id).length;
  return `<div class="card group-card">
    <div class="group-top"><span class="group-emoji">${esc(g.emoji || '🧾')}</span>
      <div><h3>${esc(g.name)}</h3><div class="card-sub">${esc(g.kind)} · ${plural(g.members.length, 'member')} · ${plural(count, 'expense')}</div></div></div>
    <div class="group-stats">
      <div><span>Group spend</span><b>${esc(fmt(spent))}</b></div>
      <div><span>Your balance</span><b class="${my > 0.004 ? 'up' : my < -0.004 ? 'down' : 'flat'}">${my > 0.004 ? '+' : ''}${esc(fmt(my))}</b></div>
    </div>
    <div class="avatar-row">${g.members.slice(0, 5).map(m => memberAvatar(m)).join('')}${g.members.length > 5 ? `<span class="more-avatar">+${g.members.length - 5}</span>` : ''}</div>
    <div class="row-actions">
      <button class="btn btn-sm" data-action="view-group" data-id="${esc(g.id)}">Open group</button>
      <button class="btn btn-sm" data-action="edit-group" data-id="${esc(g.id)}">Edit</button>
      <button class="btn btn-sm btn-danger" data-action="delete-group" data-id="${esc(g.id)}" aria-label="Delete group">✕</button>
    </div>
  </div>`;
}

/* ------------------------------- overview ------------------------------- */

function overviewView(d) {
  const ins = insightsFor(d);
  const s = ins.s;
  const suggestions = allSuggestions(d);
  const recent = activityItems(d).slice(0, 5);
  const groups = [...d.groups].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 4);
  const groupBars = d.groups.map(g => {
    const value = d.expenses.filter(e => e.groupId === g.id)
      .reduce((n, e) => n + (Number(e.amount) || 0), 0);
    return { label: g.name, value: roundCents(value), display: fmt(value, 0), color: colorFor(g.id, CATEGORY_COLORS) };
  }).filter(x => x.value > 0).sort((a, b) => b.value - a.value).slice(0, 6);
  const netLabel = s.myNet > 0.004 ? 'You are owed' : s.myNet < -0.004 ? 'You owe' : 'All square';
  return `${pageHead('Your shared money, at a glance', BRAND.tagline, `<button class="btn btn-primary" data-action="add-expense">＋ Add expense</button>`)}
    <div class="card hero-card" style="margin-bottom:18px">
      <div class="hero-card-grid">
        <div><div class="stat-label">Total outstanding</div><div class="hero-value">${esc(fmt(s.outstanding))}</div>
          <div class="hero-meta"><span>${plural(s.groups, 'group')}</span><span>·</span><span>${plural(suggestions.length, 'payment')} to settle up</span></div></div>
        <div class="hero-side">
          <div class="stat-label">Your net balance</div>
          <div class="hero-net ${s.myNet > 0.004 ? 'up' : s.myNet < -0.004 ? 'down' : 'flat'}">${esc(fmt(s.myNet))}</div>
          <p class="muted small">${netLabel}. Positive means others owe you; negative means you owe.</p>
          <div class="btn-row" style="margin-top:14px">
            <button class="btn btn-sm" data-action="add-expense">＋ Add expense</button>
            <button class="btn btn-sm" data-action="add-settlement">Record payment</button>
          </div>
        </div>
      </div>
    </div>

    <div class="grid grid-4" style="margin-bottom:18px">
      <div class="card stat-card"><div class="stat-label">Groups</div><div class="stat-value">${s.groups}</div><div class="stat-foot">${plural(s.members, 'member')} in total</div></div>
      <div class="card stat-card"><div class="stat-label">Expenses logged</div><div class="stat-value">${s.expenses}</div><div class="stat-foot">${esc(fmt(s.totalSpent, 0))} shared</div></div>
      <div class="card stat-card"><div class="stat-label">Average expense</div><div class="stat-value">${esc(fmt(s.avg, 0))}</div><div class="stat-foot">Across every group</div></div>
      <div class="card stat-card"><div class="stat-label">Settlements recorded</div><div class="stat-value">${d.settlements.length}</div><div class="stat-foot">${esc(fmt(s.settled, 0))} paid back</div></div>
    </div>

    <div class="grid grid-main" style="margin-bottom:18px">
      <div class="card">
        <div class="card-head"><div><h3>Spend by category</h3><div class="card-sub">Every expense, all groups</div></div></div>
        ${ins.categorySegments.length
          ? `<div class="donut-layout">${donut(ins.categorySegments, { size: 168, label: 'Shared', value: fmt(s.totalSpent, 0) })}
              <div class="legend">${ins.categorySegments.map(seg => `<div class="legend-item"><span class="legend-dot" style="background:${esc(seg.color)}"></span><span class="nm">${esc(seg.label)}</span><b>${esc(fmt(seg.value, 0))}</b></div>`).join('')}</div>
            </div>`
          : emptyState('◔', 'No expenses yet', 'Log a shared expense to see the category mix.')}
      </div>
      <div class="card">
        <div class="card-head"><div><h3>Settle up</h3><div class="card-sub">Shortest path to even</div></div><a class="btn btn-sm" href="${ROUTES.balances}">All balances →</a></div>
        ${suggestions.length ? `<div class="stack" style="gap:10px">${suggestions.slice(0, 3).map(sug => {
          const from = memberById(sug.group, sug.fromId);
          const to = memberById(sug.group, sug.toId);
          return `<div class="settle-row">
            ${memberAvatar(from)}${memberAvatar(to)}
            <div class="settle-copy"><b>${esc(memberName(sug.group, sug.fromId))} → ${esc(memberName(sug.group, sug.toId))}</b><small>${esc(sug.group.name)}</small></div>
            <strong>${esc(fmt(sug.amount))}</strong>
            <button class="btn btn-sm btn-primary" data-action="record-suggestion" data-group="${esc(sug.groupId)}" data-from="${esc(sug.fromId)}" data-to="${esc(sug.toId)}" data-amount="${esc(sug.amount)}">Record</button>
          </div>`;
        }).join('')}</div>`
          : emptyState('✓', 'All settled up', s.groups ? 'No outstanding debts across your groups. Nice work.' : 'Create a group and log an expense to get started.')}
      </div>
    </div>

    <div class="grid grid-main" style="margin-bottom:18px">
      <div class="card">
        <div class="card-head"><div><h3>Recent activity</h3><div class="card-sub">Newest first</div></div><a class="btn btn-sm" href="${ROUTES.activity}">View all →</a></div>
        ${activityList(recent, d, { compact: true })}
      </div>
      <div class="stack">
        <div class="card">
          <div class="card-head"><div><h3>Your groups</h3><div class="card-sub">Where the money is shared</div></div><a class="btn btn-sm" href="${ROUTES.groups}">Manage</a></div>
          ${groups.length ? `<div class="stack" style="gap:10px">${groups.map(g => {
            const net = netFor(d, g.id);
            const mine = new Set(myMemberIds(d));
            let my = 0; Object.entries(net).forEach(([id, v]) => { if (mine.has(id)) my += v; });
            return `<a class="mini-group" href="#/app/groups/${encodeURIComponent(g.id)}">
              <span class="group-emoji sm">${esc(g.emoji || '🧾')}</span>
              <span class="mini-group-name"><b>${esc(g.name)}</b><small>${plural(g.members.length, 'member')}</small></span>
              <span class="${my > 0.004 ? 'up' : my < -0.004 ? 'down' : 'flat'}">${esc(fmt(my))}</span></a>`;
          }).join('')}</div>` : emptyState('◎', 'No groups yet', 'A group is where shared expenses live.', `<button class="btn btn-primary btn-sm" data-action="add-group">Create a group</button>`)}
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><div><h3>Tandem insights</h3><div class="card-sub">Deterministic, calculated from your records only</div></div><span class="tag-pill">No AI provider</span></div>
      <div class="grid grid-4" style="margin-bottom:20px">
        <div class="insight"><span class="ic">♛</span><div><strong>Who paid most</strong><p>${ins.topPayer ? `${esc(ins.topPayer[0])} · ${esc(fmt(ins.topPayer[1], 0))}` : 'Log an expense to find out.'}</p></div></div>
        <div class="insight"><span class="ic">◈</span><div><strong>Biggest category</strong><p>${ins.topCategory ? `${esc(ins.topCategory[0])} · ${esc(fmt(ins.topCategory[1], 0))}` : 'No categories recorded yet.'}</p></div></div>
        <div class="insight"><span class="ic">◎</span><div><strong>Busiest group</strong><p>${ins.busiest ? `${esc(ins.busiest.name)} · ${plural(ins.busiestCount, 'expense')}` : 'No group activity yet.'}</p></div></div>
        <div class="insight"><span class="ic">÷</span><div><strong>Average expense</strong><p>${s.expenses ? `${esc(fmt(s.avg))} per expense` : 'Nothing to average yet.'}</p></div></div>
      </div>
      <div class="grid grid-2" style="margin-top:6px">
        <div><h4 class="chart-title">Shared expenses by month</h4>
          ${columnChart(ins.monthly, { label: 'Shared expenses by month', color: '#e9685a' })}</div>
        <div><h4 class="chart-title">Spend by group</h4>
          ${groupBars.length ? bars(groupBars, { label: 'Spend by group' }) : '<div class="chart-empty">Log an expense in a group to compare spend.</div>'}</div>
      </div>
      <p class="data-note">Insights are simple totals and averages over local data. No model download, no external analysis, no bank connection.</p>
    </div>`;
}

/* -------------------------------- groups -------------------------------- */

function groupsView(d, param) {
  const detail = param ? groupById(param, d) : null;
  if (param && !detail) {
    return `${pageHead('Group not found', 'This group may have been deleted.')}
      <div class="card">${emptyState('◎', 'No such group', 'Head back to the group list and choose another.', `<a class="btn btn-primary btn-sm" href="${ROUTES.groups}">All groups</a>`)}</div>`;
  }
  if (detail) return groupDetail(detail, d);
  return `${pageHead('Groups', 'Households, trips and events — all in one place.', `<button class="btn btn-primary" data-action="add-group">＋ New group</button>`)}
    <div class="grid grid-3">
      ${d.groups.length ? d.groups.map(g => groupCard(g, d)).join('')
        : `<div style="grid-column:1/-1">${emptyState('◎', 'No groups yet', 'Start with a household, a trip or an event — then add the people who share the cost.', `<button class="btn btn-primary" data-action="add-group">Create your first group</button>`)}</div>`}
    </div>`;
}

function groupDetail(g, d) {
  const net = netFor(d, g.id);
  const mine = new Set(myMemberIds(d));
  let my = 0;
  Object.entries(net).forEach(([id, v]) => { if (mine.has(id)) my += v; });
  my = roundCents(my);
  const groupExpenses = d.expenses.filter(e => e.groupId === g.id)
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  const spent = groupExpenses.reduce((n, e) => n + (Number(e.amount) || 0), 0);
  const suggestions = settleSuggestions(net, g);
  const settled = d.settlements.filter(s => s.groupId === g.id).reduce((n, s) => n + (Number(s.amount) || 0), 0);
  return `<div class="back-row"><a href="${ROUTES.groups}">← All groups</a></div>
    ${pageHead(`${g.emoji || '🧾'} ${g.name}`, `${g.kind} · Created ${dateLabel(g.createdAt, { short: true })}`, `<div class="btn-row">
      <button class="btn" data-action="edit-group" data-id="${esc(g.id)}">Edit group</button>
      <button class="btn btn-danger" data-action="delete-group" data-id="${esc(g.id)}">Delete</button></div>`)}
    <div class="grid grid-4" style="margin-bottom:18px">
      <div class="card stat-card"><div class="stat-label">Group spend</div><div class="stat-value">${esc(fmt(spent))}</div><div class="stat-foot">${plural(groupExpenses.length, 'expense')}</div></div>
      <div class="card stat-card"><div class="stat-label">Your balance</div><div class="stat-value ${my > 0.004 ? 'up' : my < -0.004 ? 'down' : 'flat'}">${esc(fmt(my))}</div><div class="stat-foot">${my > 0.004 ? 'Owed to you' : my < -0.004 ? 'You owe' : 'All square'}</div></div>
      <div class="card stat-card"><div class="stat-label">Outstanding</div><div class="stat-value">${esc(fmt(Object.values(net).filter(v => v > 0).reduce((a, b) => a + b, 0)))}</div><div class="stat-foot">Left to settle</div></div>
      <div class="card stat-card"><div class="stat-label">Settled so far</div><div class="stat-value">${esc(fmt(settled))}</div><div class="stat-foot">${plural(d.settlements.filter(s => s.groupId === g.id).length, 'payment')}</div></div>
    </div>
    <div class="grid grid-main">
      <div class="stack">
        <div class="card">
          <div class="card-head"><div><h3>Members</h3><div class="card-sub">${plural(g.members.length, 'person', 'people')} sharing this group</div></div></div>
          ${g.members.length ? `<div class="member-list">${g.members.map(m => {
            const value = net[m.id] || 0;
            return `<div class="member-row">${memberAvatar(m)}
              <div class="member-info"><b>${esc(m.name)}${mine.has(m.id) ? ' <span class="tag-pill">you</span>' : ''}</b><small>${esc(m.email || 'No email recorded')}</small></div>
              <div class="member-net ${value > 0.004 ? 'up' : value < -0.004 ? 'down' : 'flat'}"><b>${value > 0.004 ? '+' : ''}${esc(fmt(value))}</b><small>${value > 0.004 ? 'gets back' : value < -0.004 ? 'owes' : 'settled'}</small></div>
              <div class="row-actions"><button class="btn btn-sm" data-action="edit-member" data-id="${esc(m.id)}" title="Edit member">✎</button>
                <button class="btn btn-sm btn-danger" data-action="remove-member" data-id="${esc(m.id)}" title="Remove member">✕</button></div>
            </div>`;
          }).join('')}</div>` : emptyState('◎', 'No members', 'Add people to start splitting bills.')}
          <form id="member-form" class="inline-form" style="margin-top:18px">
            <input type="hidden" name="groupId" value="${esc(g.id)}"/>
            <div class="field"><label for="m-name">Add a member</label><input class="input" id="m-name" name="name" placeholder="Name" required/></div>
            <div class="field"><label for="m-email">Email (optional)</label><input class="input" id="m-email" name="email" placeholder="name@example.com"/></div>
            <div class="field"><label>Color</label>${colorField('m-color', MEMBER_COLORS[g.members.length % MEMBER_COLORS.length], MEMBER_COLORS)}</div>
            <button class="btn btn-primary" type="submit">Add member</button>
          </form>
        </div>
        <div class="card">
          <div class="card-head"><div><h3>Group expenses</h3><div class="card-sub">Most recent first</div></div>
            <button class="btn btn-sm btn-primary" data-action="add-expense" data-group="${esc(g.id)}">＋ Add expense</button></div>
          ${groupExpenses.length ? `<div class="mini-list">${groupExpenses.slice(0, 6).map(e => `
            <div class="mini-row"><span class="feed-icon expense">🧾</span>
              <div class="mini-copy"><b>${esc(e.title)}</b><small>${esc(dateLabel(e.date, { short: true }))} · ${esc(memberName(g, e.payerId))} paid · ${esc(e.category || 'Other')}</small></div>
              <strong>${esc(fmt(e.amount))}</strong>
              <button class="btn btn-sm" data-action="expense-shares" data-id="${esc(e.id)}">Shares</button>
            </div>`).join('')}</div>` : emptyState('🧾', 'No expenses in this group', 'Log the first shared cost to see balances appear.')}
        </div>
      </div>
      <div class="stack">
        <div class="card">
          <div class="card-head"><div><h3>Settle up</h3><div class="card-sub">Simplified payments for this group</div></div></div>
          ${suggestions.length ? `<div class="stack" style="gap:10px">${suggestions.map(sug => `
            <div class="settle-row">${memberAvatar(memberById(g, sug.fromId))}${memberAvatar(memberById(g, sug.toId))}
              <div class="settle-copy"><b>${esc(memberName(g, sug.fromId))} → ${esc(memberName(g, sug.toId))}</b><small>Pay back</small></div>
              <strong>${esc(fmt(sug.amount))}</strong>
              <button class="btn btn-sm btn-primary" data-action="record-suggestion" data-group="${esc(g.id)}" data-from="${esc(sug.fromId)}" data-to="${esc(sug.toId)}" data-amount="${esc(sug.amount)}">Record</button>
            </div>`).join('')}</div>` : emptyState('✓', 'All settled', 'There is nothing to pay back in this group right now.')}
          <div class="btn-row" style="margin-top:16px"><button class="btn btn-sm" data-action="add-settlement" data-group="${esc(g.id)}">Record a payment</button></div>
        </div>
        <div class="card"><div class="card-head"><h3>Breakdown</h3></div>
          <div class="kv-list">${g.members.map(m => `<div class="kv"><span>${esc(m.name)}</span><b class="${(net[m.id] || 0) > 0.004 ? 'up' : (net[m.id] || 0) < -0.004 ? 'down' : ''}">${esc(fmt(net[m.id] || 0))}</b></div>`).join('')}</div>
          <p class="data-note">Positive is owed to the member; negative is owed by them. Settlements reduce these amounts.</p>
        </div>
      </div>
    </div>`;
}

/* ------------------------------- expenses ------------------------------- */

function shareLine(expense, group) {
  const parts = splitAmounts(expense, group);
  return `<div class="share-line">${group.members.map(m => {
    const color = safeColor(m.color, memberColor(m.name));
    return `<span class="share-mini"><i style="background:${color}"></i>${esc(m.name.split(' ')[0] || m.name)} <b>${esc(fmt(parts[m.id] || 0))}</b></span>`;
  }).join('')}</div>`;
}

function filteredExpenses(d) {
  const f = state.expenseFilter;
  const q = String(f.search || '').trim().toLowerCase();
  return [...d.expenses]
    .filter(e => f.group === 'all' || e.groupId === f.group)
    .filter(e => {
      if (!q) return true;
      const g = groupById(e.groupId, d);
      return `${e.title || ''} ${e.note || ''} ${e.category || ''} ${memberName(g, e.payerId)} ${g?.name || ''}`.toLowerCase().includes(q);
    })
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || a.id.localeCompare(b.id));
}

function expensesView(d) {
  const rows = filteredExpenses(d);
  const total = rows.reduce((n, e) => n + (Number(e.amount) || 0), 0);
  return `${pageHead('Expenses', 'Who paid, who owes, and exactly how it splits.', `<button class="btn btn-primary" data-action="add-expense">＋ Add expense</button>`)}
    <div class="card" style="margin-bottom:18px">
      <div class="filter-bar">
        <div class="field"><label for="expense-search">Search</label><input class="input" id="expense-search" placeholder="Title, category, payer, note…" value="${esc(state.expenseFilter.search)}"/></div>
        <div class="field"><label for="expense-group">Group</label><select class="input" id="expense-group">
          <option value="all">All groups</option>${d.groups.map(g => `<option value="${esc(g.id)}" ${selected(g.id, state.expenseFilter.group)}>${esc(g.emoji)} ${esc(g.name)}</option>`).join('')}</select></div>
        <div class="field"><label for="expense-total">Showing total</label><input class="input" id="expense-total" value="${esc(fmt(total))}" readonly/></div>
      </div>
    </div>
    <div class="card">
      <div class="card-head"><div><h3>All expenses</h3><div class="card-sub" id="expense-count">${plural(rows.length, 'record')}</div></div></div>
      ${rows.length ? `<div class="table-scroll"><table class="data"><thead><tr>
        <th>Expense / shares</th><th>Group</th><th>Paid by</th><th>Category</th><th>Date</th><th>Amount</th><th>Actions</th>
      </tr></thead><tbody>${rows.map(e => {
        const g = groupById(e.groupId, d);
        return `<tr>
          <td><div class="sym-cell"><span class="group-emoji sm">${esc(g?.emoji || '🧾')}</span>
            <span><strong>${esc(e.title)}</strong><small>${esc(e.note || e.split || '')}</small></span></div>
            ${g ? shareLine(e, g) : ''}</td>
          <td class="muted">${esc(g?.name || 'Unknown group')}</td>
          <td>${esc(memberName(g, e.payerId))}</td>
          <td><span class="tag-pill">${esc(e.category || 'Other')}</span></td>
          <td class="muted">${esc(dateLabel(e.date, { short: true }))}</td>
          <td><strong>${esc(fmt(e.amount))}</strong></td>
          <td><div class="row-actions">
            <button class="btn btn-sm" data-action="expense-shares" data-id="${esc(e.id)}">Shares</button>
            <button class="btn btn-sm" data-action="edit-expense" data-id="${esc(e.id)}">Edit</button>
            <button class="btn btn-sm btn-danger" data-action="delete-expense" data-id="${esc(e.id)}" aria-label="Delete expense">✕</button>
          </div></td>
        </tr>`;
      }).join('')}</tbody></table></div>`
        : emptyState('🧾', 'No matching expenses', d.groups ? 'Try a different filter, or log a new shared cost.' : 'Create a group before logging an expense.', `<button class="btn btn-primary btn-sm" data-action="add-expense">Add expense</button>`)}
    </div>`;
}

/* ------------------------------- balances ------------------------------- */

function balancesView(d) {
  const groups = d.groups.filter(g => state.balanceGroup === 'all' || g.id === state.balanceGroup);
  const suggestions = allSuggestions(d, state.balanceGroup);
  const s = stats(d);
  return `${pageHead('Balances', 'Simplified debts and the shortest way to settle up.')}
    <div class="grid grid-3" style="margin-bottom:18px">
      <div class="card stat-card"><div class="stat-label">Total outstanding</div><div class="stat-value">${esc(fmt(state.balanceGroup === 'all' ? s.outstanding : Object.values(netFor(d, state.balanceGroup)).filter(v => v > 0).reduce((a, b) => a + b, 0)))}</div></div>
      <div class="card stat-card"><div class="stat-label">Your net</div><div class="stat-value ${s.myNet > 0.004 ? 'up' : s.myNet < -0.004 ? 'down' : 'flat'}">${esc(fmt(s.myNet))}</div></div>
      <div class="card stat-card"><div class="stat-label">Suggested payments</div><div class="stat-value">${suggestions.length}</div></div>
    </div>
    <div class="card" style="margin-bottom:18px">
      <div class="filter-bar split-filter">
        <div class="field"><label for="balance-group">Group</label><select class="input" id="balance-group">
          <option value="all">All groups</option>${d.groups.map(g => `<option value="${esc(g.id)}" ${selected(g.id, state.balanceGroup)}>${esc(g.emoji)} ${esc(g.name)}</option>`).join('')}</select></div>
        <div class="field"><label>&nbsp;</label><button class="btn" data-action="add-settlement">＋ Record a payment</button></div>
      </div>
    </div>
    ${groups.length ? groups.map(g => {
      const net = netFor(d, g.id);
      const suggestionsForGroup = settleSuggestions(net, g);
      return `<div class="card balance-card" style="margin-bottom:18px">
        <div class="card-head"><div><h3>${esc(g.emoji || '🧾')} ${esc(g.name)}</h3><div class="card-sub">${esc(g.kind)} · ${plural(g.members.length, 'member')}</div></div>
          <span class="tag-pill">${suggestionsForGroup.length ? `${plural(suggestionsForGroup.length, 'payment')} suggested` : 'All square'}</span></div>
        <div class="balance-grid">${g.members.map(m => {
          const v = net[m.id] || 0;
          return `<div class="balance-row">${memberAvatar(m)}
            <div class="member-info"><b>${esc(m.name)}</b><small>${v > 0.004 ? 'gets back' : v < -0.004 ? 'owes' : 'settled up'}</small></div>
            <strong class="${v > 0.004 ? 'up' : v < -0.004 ? 'down' : 'flat'}">${v > 0.004 ? '+' : ''}${esc(fmt(v))}</strong></div>`;
        }).join('')}</div>
        <div class="settle-block">
          ${suggestionsForGroup.length ? `<div class="stack" style="gap:9px">${suggestionsForGroup.map(sug => `
            <div class="settle-row">${memberAvatar(memberById(g, sug.fromId))}${memberAvatar(memberById(g, sug.toId))}
              <div class="settle-copy"><b>${esc(memberName(g, sug.fromId))} pays ${esc(memberName(g, sug.toId))}</b><small>${esc(g.name)}</small></div>
              <strong>${esc(fmt(sug.amount))}</strong>
              <button class="btn btn-sm btn-primary" data-action="record-suggestion" data-group="${esc(g.id)}" data-from="${esc(sug.fromId)}" data-to="${esc(sug.toId)}" data-amount="${esc(sug.amount)}">Record</button>
            </div>`).join('')}</div>` : emptyState('✓', 'Nothing to settle here', 'Every member is even in this group.')}
        </div>
      </div>`;
    }).join('') : emptyState('⚖', 'No groups to balance', 'Create a group and log a shared expense to see who owes whom.', `<button class="btn btn-primary btn-sm" data-action="add-group">Create a group</button>`)}
    <div class="notice">Balances are calculated from expenses and settlements only. Tandem pairs the biggest debtor with the biggest creditor repeatedly, which produces a short, fair settle-up plan without moving money itself.</div>`;
}

/* -------------------------------- activity ------------------------------- */

function activityView(d) {
  const items = activityItems(d, state.activityFilter);
  return `${pageHead('Activity', 'A chronological record of every shared payment.', `<button class="btn btn-primary" data-action="add-expense">＋ Add expense</button>`)}
    <div class="card" style="margin-bottom:18px">
      <div class="filter-bar split-filter">
        <div class="field"><label for="activity-group">Group</label><select class="input" id="activity-group">
          <option value="all">All groups</option>${d.groups.map(g => `<option value="${esc(g.id)}" ${selected(g.id, state.activityFilter.group)}>${esc(g.emoji)} ${esc(g.name)}</option>`).join('')}</select></div>
        <div class="field"><label for="activity-type">Type</label><select class="input" id="activity-type">
          <option value="all">Everything</option><option value="expense" ${selected('expense', state.activityFilter.type)}>Expenses</option>
          <option value="settlement" ${selected('settlement', state.activityFilter.type)}>Settlements</option></select></div>
      </div>
    </div>
    <div class="card">
      <div class="card-head"><div><h3>Timeline</h3><div class="card-sub">${plural(items.length, 'entry')} · newest first</div></div></div>
      ${activityList(items, d)}
    </div>`;
}

/* -------------------------------- settings ------------------------------- */

function settingsView(d) {
  const info = statusInfo();
  return `${pageHead('Settings', 'Preferences, sync, data and account controls.')}
    <div class="grid grid-2">
      <div class="stack">
        <div class="card"><div class="card-head"><h3>Appearance</h3></div>
          <div class="field"><label for="theme-select">Theme</label><select class="input" id="theme-select">
            <option value="cream" ${selected('cream', d.settings.theme)}>Cream (light)</option>
            <option value="plum" ${selected('plum', d.settings.theme)}>Plum (dark)</option></select></div>
          <div class="field"><label for="currency-select">Currency</label><select class="input" id="currency-select">
            ${CURRENCIES.map(c => `<option value="${esc(c)}" ${selected(c, d.settings.currency)}>${esc(c)}</option>`).join('')}</select></div>
          <p class="data-note">The quick theme switch is also in the top bar.</p>
        </div>
        <div class="card"><div class="card-head"><div><h3>Cloud sync</h3><div class="card-sub">Optional Atlas Sync service</div></div>
          <span class="badge ${info.cls === 'live' ? 'live' : info.cls === 'offline' ? 'warn' : 'neutral'}" data-sync-badge>${esc(info.badge)}</span></div>
          <form id="endpoint-form">
            <div class="field"><label for="sync-endpoint-input">API base URL</label>
              <input class="input" id="sync-endpoint-input" value="${esc(store.getSyncEndpoint())}" placeholder="${esc('https://atlas-sync.greenhenry441.workers.dev')}"/></div>
            <div class="btn-row"><button class="btn btn-primary btn-sm" type="submit">Save & test endpoint</button>
              <button class="btn btn-sm" type="button" data-action="retry-cloud">Check connection</button></div>
          </form>
          <div class="sync-grid" style="margin-top:18px">
            <div class="sync-row"><span>Signed in as</span><b>${esc(store.currentUser()?.email || '—')}</b></div>
            <div class="sync-row"><span>Auth mode</span><b>${store.authMode() === 'cloud' ? 'Cloud' : 'Local browser'}</b></div>
            <div class="sync-row"><span>Status</span><b data-sync-status>${esc(info.text)}</b></div>
            <div class="sync-row"><span>Last sync</span><b data-sync-time>${state.cloud.lastSync ? esc(dateLabel(state.cloud.lastSync, { relative: true })) : 'Not synced yet'}</b></div>
          </div>
          <div class="btn-row" style="margin-top:18px">
            ${store.authMode() === 'cloud' ? `<button class="btn btn-danger btn-sm" data-action="cloud-signout">Sign out of cloud</button>` : `<a class="btn btn-sm" href="${ROUTES.signin}">Sign in to cloud</a>`}
          </div>
        </div>
      </div>
      <div class="stack">
        <div class="card"><div class="card-head"><h3>Your data</h3><div class="card-sub">Export, import or reset</div></div>
          <div class="btn-row">
            <button class="btn" data-action="export-data">↓ Export JSON</button>
            <button class="btn" data-action="import-data">↑ Import JSON</button>
            <button class="btn btn-danger" data-action="clear-data">Clear app data</button>
          </div>
          <p class="data-note">Export includes groups, expenses, settlements and preferences. Import replaces current data after validation.</p>
        </div>
        <div class="card"><div class="card-head"><h3>Account</h3></div>
          <div class="kv-list"><div class="kv"><span>Name</span><b>${esc(store.currentUser()?.name || '—')}</b></div>
            <div class="kv"><span>Email</span><b>${esc(store.currentUser()?.email || '—')}</b></div>
            <div class="kv"><span>Local credentials</span><b>${store.authMode() === 'local' ? 'Salted PBKDF2' : 'Cloud bearer token'}</b></div></div>
          <div style="margin-top:18px"><button class="btn btn-danger btn-sm" data-action="delete-profile">Delete this account</button></div>
        </div>
        <div class="card"><div class="card-head"><h3>About Tandem</h3></div>
          <p class="muted small">${esc(BRAND.dba)} is made by ${esc(BRAND.legal)}. ${esc(BRAND.tagline)}</p>
          <div class="notice warn" style="margin-top:14px">Bank login and account aggregation are not enabled. Every expense and payment is entered manually by you or a group member.</div>
        </div>
      </div>
    </div>`;
}

/* --------------------------------- render --------------------------------- */

const VIEWS = {
  overview: overviewView, groups: groupsView, expenses: expensesView,
  balances: balancesView, activity: activityView, settings: settingsView,
};

function render({ preserveScroll = true } = {}) {
  const y = preserveScroll ? window.scrollY : 0;
  applyTheme();
  const r = route();
  if (r.mode === 'app' && !store.currentUser()) { location.hash = ROUTES.signin; return; }
  if (r.mode === 'auth' && store.currentUser()) { location.hash = ROUTES.overview; return; }
  if (r.mode === 'landing') root.innerHTML = landing();
  else if (r.mode === 'auth') root.innerHTML = authView(r.kind);
  else {
    const page = VIEWS[r.page] ? r.page : 'overview';
    const d = store.data();
    root.innerHTML = `<div class="shell">${sidebar()}<div class="main">${topbar(page)}${bannerMarkup()}
      <main class="page">${VIEWS[page](d, r.param)}</main></div></div>`;
  }
  if (preserveScroll) window.scrollTo(0, y);
  paintSyncStatus();
}

/* --------------------------------- modals --------------------------------- */

function colorField(id, value, palette = MEMBER_COLORS) {
  const chosen = safeColor(value, palette[0]);
  return `<input type="hidden" id="${esc(id)}" name="color" value="${esc(chosen)}"/>
    <div class="color-swatches">${palette.map(c => `<button type="button" class="swatch ${c.toLowerCase() === chosen.toLowerCase() ? 'active' : ''}"
      data-action="pick-color" data-target="${esc(id)}" data-color="${esc(c)}" style="background:${esc(c)}" aria-label="Choose color"></button>`).join('')}</div>`;
}

function groupModal(id) {
  const d = store.data();
  const g = d.groups.find(x => x.id === id);
  const user = store.currentUser() || {};
  openModal(`${modalHead(g ? 'Edit group' : 'Create a group', 'A home for shared expenses and the people in them.')}
    <form id="group-form"><input type="hidden" name="id" value="${esc(g?.id || '')}"/>
      <div class="field"><label for="g-name">Group name</label><input class="input" id="g-name" name="name" value="${esc(g?.name || '')}" placeholder="Household, Lisbon trip, Party…" required/></div>
      <div class="form-grid">
        <div class="field"><label for="g-kind">Type</label><select class="input" id="g-kind" name="kind">${GROUP_KINDS.map(k => `<option value="${esc(k)}" ${selected(k, g?.kind || 'Household')}>${esc(k)}</option>`).join('')}</select></div>
        <div class="field"><label for="g-emoji">Emoji</label><select class="input" id="g-emoji" name="emoji">${GROUP_EMOJIS.map(e => `<option value="${esc(e)}" ${selected(e, g?.emoji || '🏠')}>${esc(e)}</option>`).join('')}</select></div>
      </div>
      ${g ? '' : `<div class="field"><label for="g-members">Initial members (comma separated)</label>
        <input class="input" id="g-members" name="members" value="${esc(user.name || 'You')}" placeholder="You, Jamie, Riley" required/>
        <span class="field-hint">The first name is treated as you. Add more from the group page later.</span></div>`}
      <div class="form-error" id="group-error"></div>
      <div class="modal-actions"><button type="button" class="btn" data-action="modal-close">Cancel</button><button class="btn btn-primary" type="submit">${g ? 'Save changes' : 'Create group'}</button></div>
    </form>`);
}

function memberModal(groupId, memberId) {
  const g = groupById(groupId);
  if (!g) return;
  const m = memberById(g, memberId);
  openModal(`${modalHead(m ? 'Edit member' : 'Add a member', g.name)}
    <form id="member-form-modal"><input type="hidden" name="groupId" value="${esc(g.id)}"/><input type="hidden" name="memberId" value="${esc(m?.id || '')}"/>
      <div class="field"><label for="mm-name">Name</label><input class="input" id="mm-name" name="name" value="${esc(m?.name || '')}" placeholder="Jamie" required/></div>
      <div class="field"><label for="mm-email">Email (optional)</label><input class="input" id="mm-email" name="email" type="email" value="${esc(m?.email || '')}" placeholder="jamie@example.com"/></div>
      <div class="field"><label>Color</label>${colorField('mm-color', m?.color || MEMBER_COLORS[g.members.length % MEMBER_COLORS.length])}</div>
      <div class="form-error" id="member-error"></div>
      <div class="modal-actions"><button type="button" class="btn" data-action="modal-close">Cancel</button><button class="btn btn-primary" type="submit">${m ? 'Save member' : 'Add member'}</button></div>
    </form>`);
}

function splitPreview(draft, g) {
  const members = g?.members || [];
  const amount = Math.max(0, Number(draft.amount) || 0);
  if (draft.method === 'custom') {
    const parts = {};
    let assigned = 0;
    members.forEach(m => {
      const v = roundCents(Math.max(0, Number(draft.values?.[m.id]) || 0));
      parts[m.id] = v;
      assigned += v;
    });
    assigned = roundCents(assigned);
    return { parts, assigned, remaining: roundCents(amount - assigned) };
  }
  const weights = members.map(m => draft.method === 'shares'
    ? Math.max(0, Number(draft.values?.[m.id]) || 0) : 1);
  const amounts = allocateCents(amount, weights);
  const parts = {};
  members.forEach((m, i) => { parts[m.id] = amounts[i] || 0; });
  return { parts, assigned: amount, remaining: 0 };
}

function refreshSplitPreview() {
  const draft = state.expenseDraft;
  const g = groupById(draft?.groupId);
  if (!g || !draft) return;
  const info = splitPreview(draft, g);
  $$('[data-share-preview]').forEach(el => {
    const id = el.dataset.sharePreview;
    el.textContent = fmt(info.parts[id] || 0);
  });
  const total = $('#split-total');
  if (total) total.textContent = `Total ${fmt(draft.amount || 0)}`;
  const remaining = $('#split-remaining');
  if (remaining) {
    remaining.textContent = Math.abs(info.remaining) < 0.005
      ? 'Custom amounts add up exactly.'
      : `${fmt(Math.abs(info.remaining))} ${info.remaining > 0 ? 'left to assign' : 'over the total'}.`;
    remaining.className = Math.abs(info.remaining) < 0.005 ? 'split-ok' : 'split-warn';
  }
}

function splitEditorMarkup(g, draft) {
  const head = `<div class="split-head"><b>Split between ${plural(g.members.length, 'person', 'people')}</b><span id="split-total">Total ${fmt(draft.amount || 0)}</span></div>`;
  const rows = g.members.map(m => {
    const value = draft.values?.[m.id] ?? 1;
    const input = draft.method === 'equal'
      ? '<span class="split-fixed">equal share</span>'
      : `<input class="input compact" type="number" step="0.01" min="0" data-split-value="${esc(m.id)}" value="${esc(value)}" aria-label="${esc(m.name)} ${draft.method === 'shares' ? 'share weight' : 'custom amount'}"/>`;
    return `<div class="split-row">${memberAvatar(m)}<div class="split-name">${esc(m.name)}</div>${input}
      <div class="split-preview" data-share-preview="${esc(m.id)}">—</div></div>`;
  }).join('');
  let footer = '';
  if (draft.method === 'custom') {
    footer = `<div class="split-footer"><span id="split-remaining"></span>
      <button type="button" class="btn btn-sm" data-action="expense-distribute">Distribute evenly</button></div>`;
  } else if (draft.method === 'shares') {
    footer = `<p class="field-hint">Use weights, e.g. 2 for a double share. A weight of 0 means no share. If all weights are 0, the amount splits evenly.</p>`;
  } else {
    footer = `<p class="field-hint">Each person pays the same amount. Leftover cents are assigned deterministically so the shares always add up.</p>`;
  }
  return head + `<div class="split-rows">${rows}</div>` + footer;
}

function expenseModalPaint() {
  const draft = state.expenseDraft;
  const d = store.data();
  const g = groupById(draft?.groupId, d);
  if (!g) return;
  const payerOptions = g.members.map(m => `<option value="${esc(m.id)}" ${selected(m.id, draft.payerId)}>${esc(m.name)}</option>`).join('');
  openModal(`${modalHead(draft.id ? 'Edit expense' : 'Add a shared expense', 'All amounts are entered manually — no bank connection.')}
    <form id="expense-form"><input type="hidden" name="id" value="${esc(draft.id)}"/>
      <div class="form-grid">
        <div class="field"><label for="e-group">Group</label><select class="input" id="e-group" name="groupId">${d.groups.map(x => `<option value="${esc(x.id)}" ${selected(x.id, draft.groupId)}>${esc(x.emoji)} ${esc(x.name)}</option>`).join('')}</select></div>
        <div class="field"><label for="e-title">What was it?</label><input class="input" id="e-title" name="title" value="${esc(draft.title)}" placeholder="Groceries, taxi, tickets…" required/></div>
      </div>
      <div class="form-grid">
        <div class="field"><label for="e-amount">Amount</label><input class="input" id="e-amount" name="amount" type="number" step="0.01" min="0" value="${esc(draft.amount)}" placeholder="0.00" required/></div>
        <div class="field"><label for="e-date">Date</label><input class="input" id="e-date" name="date" type="date" value="${esc(draft.date)}" required/></div>
      </div>
      <div class="form-grid">
        <div class="field"><label for="e-payer">Paid by</label><select class="input" id="e-payer" name="payerId">${payerOptions}</select></div>
        <div class="field"><label for="e-category">Category</label><select class="input" id="e-category" name="category">${EXPENSE_CATEGORIES.map(c => `<option value="${esc(c)}" ${selected(c, draft.category || 'Other')}>${esc(c)}</option>`).join('')}</select></div>
      </div>
      <div class="field"><label for="e-note">Note (optional)</label><textarea class="input" id="e-note" name="note" placeholder="Anything the group should remember…">${esc(draft.note)}</textarea></div>
      <div class="field"><label for="e-method">Split method</label><select class="input" id="e-method" name="method">${SPLIT_METHODS.map(m => `<option value="${esc(m)}" ${selected(m, draft.method)}>${m === 'equal' ? 'Equally' : m === 'shares' ? 'By shares (weights)' : 'Custom amounts'}</option>`).join('')}</select></div>
      <div class="split-editor">${splitEditorMarkup(g, draft)}</div>
      <div class="form-error" id="expense-error"></div>
      <div class="modal-actions"><button type="button" class="btn" data-action="modal-close">Cancel</button><button class="btn btn-primary" type="submit">${draft.id ? 'Save changes' : 'Add expense'}</button></div>
    </form>`, true);
  refreshSplitPreview();
}

function expenseModal(id, presetGroupId) {
  const d = store.data();
  const e = d.expenses.find(x => x.id === id);
  const gid = e?.groupId || presetGroupId || d.groups[0]?.id || '';
  const g = groupById(gid, d);
  if (!g) { toast('Create a group before adding an expense.', 'error'); return; }
  const method = e?.split || 'equal';
  const resolved = e ? splitAmounts(e, g) : {};
  const mine = new Set(myMemberIds(d));
  const values = {};
  g.members.forEach(m => {
    if (method === 'shares') values[m.id] = e?.shares?.[m.id] ?? 1;
    else if (method === 'custom') values[m.id] = e?.custom?.[m.id] ?? resolved[m.id] ?? 0;
    else values[m.id] = 1;
  });
  state.expenseDraft = {
    id: e?.id || '', groupId: gid, title: e?.title || '', amount: e ? String(e.amount) : '',
    date: e?.date || dateInput(),
    payerId: e?.payerId || g.members.find(m => mine.has(m.id))?.id || g.members[0]?.id || '',
    category: e?.category || 'Groceries', note: e?.note || '', method, values,
  };
  expenseModalPaint();
}

function syncExpenseDraftFromForm() {
  const form = $('#expense-form');
  const draft = state.expenseDraft;
  if (!form || !draft) return;
  const fd = new FormData(form);
  draft.groupId = String(fd.get('groupId') || '');
  draft.title = String(fd.get('title') || '');
  draft.amount = String(fd.get('amount') || '');
  draft.date = String(fd.get('date') || '');
  draft.payerId = String(fd.get('payerId') || '');
  draft.category = String(fd.get('category') || 'Other');
  draft.note = String(fd.get('note') || '');
  draft.method = String(fd.get('method') || 'equal');
  $$('[data-split-value]', form).forEach(el => { draft.values[el.dataset.splitValue] = el.value; });
}

function prepareDraftValues(g, draft) {
  const values = {};
  g.members.forEach(m => { values[m.id] = draft.values?.[m.id] ?? 1; });
  draft.values = values;
  if (!g.members.some(m => m.id === draft.payerId)) draft.payerId = g.members[0]?.id || '';
}

function expenseSharesModal(id) {
  const d = store.data();
  const e = d.expenses.find(x => x.id === id);
  const g = groupById(e?.groupId, d);
  if (!e || !g) return;
  const parts = splitAmounts(e, g);
  const total = Math.max(0, Number(e.amount) || 0);
  const label = e.split === 'equal' ? 'Split equally' : e.split === 'shares' ? 'By shares' : 'Custom amounts';
  openModal(`${modalHead('Split details', `${e.title} · ${fmt(e.amount)}`)}
    <div class="kv-list" style="margin-bottom:16px">
      <div class="kv"><span>Group</span><b>${esc(g.emoji)} ${esc(g.name)}</b></div>
      <div class="kv"><span>Paid by</span><b>${esc(memberName(g, e.payerId))}</b></div>
      <div class="kv"><span>Method</span><b>${esc(label)}</b></div>
      <div class="kv"><span>Date</span><b>${esc(dateLabel(e.date, { short: true }))}</b></div>
    </div>
    <table class="data"><thead><tr><th>Member</th><th>Share</th><th>Of total</th></tr></thead><tbody>
      ${g.members.map(m => `<tr><td><div class="sym-cell">${memberAvatar(m)}<strong>${esc(m.name)}</strong></div></td>
        <td>${esc(fmt(parts[m.id] || 0))}</td><td class="muted">${total ? ((parts[m.id] || 0) / total * 100).toFixed(1) : '0.0'}%</td></tr>`).join('')}
    </tbody></table>
    ${e.note ? `<p class="data-note">${esc(e.note)}</p>` : ''}
    <div class="modal-actions"><button type="button" class="btn" data-action="modal-close">Close</button>
      <button type="button" class="btn btn-primary" data-action="edit-expense" data-id="${esc(e.id)}">Edit expense</button></div>`);
}

function settlementMemberOptions(g, chosen) {
  return g.members.map(m => `<option value="${esc(m.id)}" ${selected(m.id, chosen)}>${esc(m.name)}</option>`).join('');
}

function settlementModal(preset = {}) {
  const d = store.data();
  if (!d.groups.length) { toast('Create a group before recording a payment.', 'error'); return; }
  const gid = preset.groupId || d.groups[0].id;
  const g = groupById(gid, d);
  const fromId = preset.fromId || g.members[0]?.id || '';
  const toId = preset.toId || g.members.find(m => m.id !== fromId)?.id || '';
  state.settlementDraft = {
    groupId: gid, fromId, toId,
    amount: preset.amount ? String(preset.amount) : '',
    date: dateInput(), note: '',
  };
  settlementModalPaint();
}

function settlementModalPaint() {
  const draft = state.settlementDraft;
  const d = store.data();
  const g = groupById(draft.groupId, d);
  if (!g) return;
  openModal(`${modalHead('Record a settlement', 'A payment between members that reduces what they owe.')}
    <form id="settlement-form">
      <input type="hidden" name="groupId" value="${esc(draft.groupId)}"/>
      <div class="field"><label for="s-group">Group</label><select class="input" id="s-group" name="groupId">${d.groups.map(x => `<option value="${esc(x.id)}" ${selected(x.id, draft.groupId)}>${esc(x.emoji)} ${esc(x.name)}</option>`).join('')}</select></div>
      <div class="form-grid">
        <div class="field"><label for="s-from">From (payer)</label><select class="input" id="s-from" name="fromId">${settlementMemberOptions(g, draft.fromId)}</select></div>
        <div class="field"><label for="s-to">To (receiver)</label><select class="input" id="s-to" name="toId">${settlementMemberOptions(g, draft.toId)}</select></div>
      </div>
      <div class="form-grid">
        <div class="field"><label for="s-amount">Amount</label><input class="input" id="s-amount" name="amount" type="number" step="0.01" min="0" value="${esc(draft.amount)}" placeholder="0.00" required/></div>
        <div class="field"><label for="s-date">Date</label><input class="input" id="s-date" name="date" type="date" value="${esc(draft.date)}" required/></div>
      </div>
      <div class="field"><label for="s-note">Note (optional)</label><input class="input" id="s-note" name="note" value="${esc(draft.note)}" placeholder="Paid back for dinner"/></div>
      <p class="field-hint" id="set-hint"></p>
      <div class="form-error" id="settlement-error"></div>
      <div class="modal-actions"><button type="button" class="btn" data-action="modal-close">Cancel</button><button class="btn btn-primary" type="submit">Record payment</button></div>
    </form>`);
  updateSettlementHint();
}

function syncSettlementDraftFromForm() {
  const form = $('#settlement-form');
  const draft = state.settlementDraft;
  if (!form || !draft) return;
  const fd = new FormData(form);
  draft.groupId = String(fd.get('groupId') || '');
  draft.fromId = String(fd.get('fromId') || '');
  draft.toId = String(fd.get('toId') || '');
  draft.amount = String(fd.get('amount') || '');
  draft.date = String(fd.get('date') || '');
  draft.note = String(fd.get('note') || '');
}

function updateSettlementHint() {
  const draft = state.settlementDraft;
  const g = groupById(draft?.groupId);
  const hint = $('#set-hint');
  if (!g || !hint || !draft) return;
  const net = netFor(store.data(), g.id);
  const debt = Math.max(0, -(net[draft.fromId] || 0));
  hint.textContent = debt > 0.004
    ? `${memberName(g, draft.fromId)} currently owes ${fmt(debt)} in this group.`
    : `${memberName(g, draft.fromId)} has no outstanding debt in this group right now.`;
}

function importModal() {
  openModal(`${modalHead('Import Tandem data', 'Paste an export or choose a JSON file.')}
    <form id="import-form">
      <div class="field"><label for="import-file">JSON file</label><input class="input" id="import-file" type="file" accept="application/json,.json"/></div>
      <div class="field"><label for="import-json">Or paste JSON</label><textarea class="input" id="import-json" placeholder='{"app":"Tandem Finance","data":{…}}'></textarea></div>
      <div class="form-error" id="import-error"></div>
      <div class="modal-actions"><button type="button" class="btn" data-action="modal-close">Cancel</button><button class="btn btn-primary" type="submit">Import and replace</button></div>
    </form>`);
}

/* -------------------------------- actions -------------------------------- */

document.addEventListener('click', async e => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;

  if (action === 'modal-backdrop') { if (e.target === el) closeModal(); return; }
  if (action === 'modal-close') { closeModal(); return; }
  if (action === 'toggle-theme') {
    store.setPref('theme', store.getPrefs().theme === 'cream' ? 'plum' : 'cream');
    applyTheme(); render({ preserveScroll: true }); return;
  }
  if (action === 'toggle-mobile-nav') { toast('Use the bottom navigation to move between pages.'); return; }
  if (action === 'set-auth-backend') {
    if (el.disabled) return;
    state.authBackend = el.dataset.backend; render({ preserveScroll: true }); return;
  }
  if (action === 'auth-fallback-local') {
    state.authBackend = 'local';
    if (state.lastAuth) performAuth(state.lastAuth.kind, 'local');
    return;
  }
  if (action === 'retry-cloud') {
    await checkCloud({ silent: true });
    state.cloud.bannerDismissed = false;
    if (store.authMode() === 'cloud' && state.cloud.phase === 'online') syncEventsForCurrentConfig();
    render({ preserveScroll: true });
    toast(state.cloud.available ? 'Cloud endpoint reachable.' : 'Cloud endpoint still unavailable.', state.cloud.available ? 'success' : 'error');
    return;
  }
  if (action === 'dismiss-banner') { state.cloud.bannerDismissed = true; render({ preserveScroll: true }); return; }
  if (action === 'onboard-theme') {
    readOnboardFields(); state.onboarding.theme = el.dataset.theme; onboardingModal(); return;
  }
  if (action === 'pick-color') {
    const target = $(`#${el.dataset.target}`);
    if (target) target.value = el.dataset.color;
    $$(`[data-action="pick-color"][data-target="${el.dataset.target}"]`).forEach(s => s.classList.toggle('active', s === el));
    return;
  }

  if (action === 'add-group') { groupModal(); return; }
  if (action === 'edit-group') { groupModal(el.dataset.id); return; }
  if (action === 'view-group') { go(`#/app/groups/${encodeURIComponent(el.dataset.id)}`); return; }
  if (action === 'delete-group') {
    confirmModal({ title: 'Delete this group?', body: 'Its expenses and settlements will also be removed. This cannot be undone.', action: 'confirm-delete-group', id: el.dataset.id });
    return;
  }
  if (action === 'confirm-delete-group') {
    const id = el.dataset.id;
    store.updateData(d => {
      d.groups = d.groups.filter(g => g.id !== id);
      d.expenses = d.expenses.filter(x => x.groupId !== id);
      d.settlements = d.settlements.filter(s => s.groupId !== id);
    });
    closeModal(); toast('Group deleted.');
    go(ROUTES.groups); render({ preserveScroll: true }); return;
  }
  if (action === 'add-member') { memberModal(el.dataset.group || route().param); return; }
  if (action === 'edit-member') { memberModal(route().param, el.dataset.id); return; }
  if (action === 'remove-member') {
    const gid = route().param;
    const g = groupById(gid);
    const mid = el.dataset.id;
    const used = g && (g.members.length <= 1
      || store.data().expenses.some(x => x.groupId === gid && (x.payerId === mid || x.shares?.[mid] != null || x.custom?.[mid] != null))
      || store.data().settlements.some(s => s.groupId === gid && (s.fromId === mid || s.toId === mid)));
    if (used) {
      toast('This member has records in the group. Edit or remove those records first; a group needs at least one member.', 'error');
      return;
    }
    confirmModal({ title: 'Remove this member?', body: 'They have no expenses or settlements in this group, so they can be removed safely.', action: 'confirm-remove-member', id: mid });
    return;
  }
  if (action === 'confirm-remove-member') {
    const gid = route().param;
    store.updateData(d => {
      const g = d.groups.find(x => x.id === gid);
      if (g) g.members = g.members.filter(m => m.id !== el.dataset.id);
    });
    closeModal(); toast('Member removed.'); render({ preserveScroll: true }); return;
  }

  if (action === 'add-expense') { expenseModal(null, el.dataset.group); return; }
  if (action === 'edit-expense') { expenseModal(el.dataset.id); return; }
  if (action === 'delete-expense') {
    confirmModal({ title: 'Delete this expense?', body: 'The expense and its share breakdown will be removed from the group.', action: 'confirm-delete-expense', id: el.dataset.id });
    return;
  }
  if (action === 'confirm-delete-expense') {
    store.updateData(d => { d.expenses = d.expenses.filter(x => x.id !== el.dataset.id); });
    closeModal(); toast('Expense deleted.'); render({ preserveScroll: true }); return;
  }
  if (action === 'expense-shares') { expenseSharesModal(el.dataset.id); return; }
  if (action === 'expense-distribute') {
    syncExpenseDraftFromForm();
    const draft = state.expenseDraft;
    const g = groupById(draft.groupId);
    if (!g) return;
    const parts = allocateCents(Number(draft.amount) || 0, g.members.map(() => 1));
    g.members.forEach((m, i) => {
      draft.values[m.id] = parts[i];
      const input = $(`[data-split-value="${m.id}"]`);
      if (input) input.value = String(parts[i]);
    });
    refreshSplitPreview();
    toast('Amounts distributed evenly.');
    return;
  }

  if (action === 'add-settlement') { settlementModal({ groupId: el.dataset.group }); return; }
  if (action === 'record-suggestion') {
    settlementModal({
      groupId: el.dataset.group, fromId: el.dataset.from, toId: el.dataset.to,
      amount: Number(el.dataset.amount) || 0,
    });
    return;
  }

  if (action === 'export-data') {
    const blob = new Blob([store.exportData()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tandem-finance-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('Tandem data exported.'); return;
  }
  if (action === 'import-data') { importModal(); return; }
  if (action === 'clear-data') {
    confirmModal({ title: 'Clear all app data?', body: 'Groups, expenses, settlements and preferences will be removed from this workspace.', action: 'confirm-clear-data', id: 'all' });
    return;
  }
  if (action === 'confirm-clear-data') {
    store.clearData(); closeModal(); toast('App data cleared.'); render({ preserveScroll: false }); return;
  }
  if (action === 'cloud-signout') {
    confirmModal({ title: 'Sign out of cloud sync?', body: 'Your local data stays in this browser. Live sync and event updates will stop until you sign in again.', action: 'confirm-cloud-signout', id: 'cloud' });
    return;
  }
  if (action === 'confirm-cloud-signout') {
    stopEvents(); store.signOut();
    state.cloud.status = 'local'; state.syncReady = false;
    closeModal(); toast('Signed out of cloud sync.'); render({ preserveScroll: true }); return;
  }
  if (action === 'delete-profile') {
    confirmModal({ title: 'Delete this account?', body: 'Local credentials and all data for this account will be removed from this browser.', action: 'confirm-delete-profile', id: 'me' });
    return;
  }
  if (action === 'confirm-delete-profile') {
    stopEvents(); store.deleteAccount();
    state.syncReady = false; state.cloud.status = 'local';
    closeModal(); toast('Account deleted.'); go(ROUTES.landing); return;
  }
});

/* --------------------------------- forms --------------------------------- */

document.addEventListener('submit', async e => {
  const form = e.target;
  const formId = form.getAttribute('id') || '';
  e.preventDefault();

  if (formId === 'signin-form' || formId === 'signup-form') {
    const kind = formId === 'signup-form' ? 'signup' : 'signin';
    const fd = new FormData(form);
    state.lastAuth = {
      kind, name: String(fd.get('name') || ''),
      email: String(fd.get('email') || '').trim(), password: String(fd.get('password') || ''),
    };
    await performAuth(kind, effectiveBackend());
    return;
  }

  if (formId === 'onboarding-form') { finishOnboarding(); return; }

  if (formId === 'group-form') {
    const fd = new FormData(form);
    const name = String(fd.get('name') || '').trim();
    if (!name) { $('#group-error').textContent = 'Give the group a name.'; return; }
    const id = String(fd.get('id') || '');
    const payload = {
      name, emoji: String(fd.get('emoji') || '🧾'),
      kind: GROUP_KINDS.includes(fd.get('kind')) ? String(fd.get('kind')) : 'Other',
    };
    const user = store.currentUser() || {};
    store.updateData(d => {
      if (id) {
        const g = d.groups.find(x => x.id === id);
        if (g) Object.assign(g, payload);
      } else {
        const names = String(fd.get('members') || '').split(',').map(n => n.trim()).filter(Boolean).slice(0, 8);
        if (!names.length) names.push(user.name || 'You');
        d.groups.push({
          id: uid('grp'), ...payload,
          members: names.map((n, i) => ({
            id: uid('mem'), name: n, email: i === 0 ? String(user.email || '') : '',
            color: MEMBER_COLORS[i % MEMBER_COLORS.length],
          })),
          createdAt: Date.now(),
        });
      }
    });
    closeModal(); toast(id ? 'Group updated.' : 'Group created.'); render({ preserveScroll: true }); return;
  }

  if (formId === 'member-form' || formId === 'member-form-modal') {
    const fd = new FormData(form);
    const name = String(fd.get('name') || '').trim();
    const gid = String(fd.get('groupId') || '');
    if (!name) { const err = $('#member-error'); if (err) err.textContent = 'Enter a member name.'; return; }
    const memberId = String(fd.get('memberId') || '');
    store.updateData(d => {
      const g = d.groups.find(x => x.id === gid);
      if (!g) return;
      const payload = {
        name, email: String(fd.get('email') || '').trim(),
        color: safeColor(fd.get('color'), memberColor(name)),
      };
      if (memberId) g.members = g.members.map(m => m.id === memberId ? { ...m, ...payload } : m);
      else g.members.push({ id: uid('mem'), ...payload });
    });
    closeModal(); toast(memberId ? 'Member updated.' : 'Member added.'); render({ preserveScroll: true }); return;
  }

  if (formId === 'expense-form') {
    syncExpenseDraftFromForm();
    const draft = state.expenseDraft;
    const d = store.data();
    const g = groupById(draft.groupId, d);
    const amount = Number(draft.amount);
    const errorEl = $('#expense-error');
    const fail = msg => { if (errorEl) errorEl.textContent = msg; };
    if (!g) { fail('Choose a group.'); return; }
    if (!draft.title.trim()) { fail('Give the expense a title.'); return; }
    if (!(amount > 0)) { fail('Enter an amount greater than zero.'); return; }
    if (!g.members.some(m => m.id === draft.payerId)) { fail('Choose who paid.'); return; }

    const info = splitPreview(draft, g);
    const shares = {}, custom = {};
    if (draft.method === 'custom') {
      if (Math.abs(info.remaining) > 0.009) {
        fail(`Custom amounts must add up to ${fmt(amount)}. ${fmt(Math.abs(info.remaining))} ${info.remaining > 0 ? 'still to assign' : 'over the total'}.`);
        return;
      }
      g.members.forEach(m => {
        const v = roundCents(Number(draft.values[m.id]) || 0);
        custom[m.id] = v; shares[m.id] = v;
      });
    } else if (draft.method === 'shares') {
      let totalWeight = 0;
      g.members.forEach(m => {
        const w = Math.max(0, Number(draft.values[m.id]) || 0);
        shares[m.id] = w; custom[m.id] = 0; totalWeight += w;
      });
      if (totalWeight <= 0) { fail('At least one share weight must be greater than zero.'); return; }
    } else {
      g.members.forEach(m => { shares[m.id] = 1; custom[m.id] = info.parts[m.id] || 0; });
    }

    const payload = {
      groupId: draft.groupId, date: draft.date || dateInput(), title: draft.title.trim(),
      amount: roundCents(amount), payerId: draft.payerId, split: draft.method,
      shares, custom, note: draft.note.trim(), category: draft.category || 'Other',
    };
    store.updateData(data => {
      if (draft.id) data.expenses = data.expenses.map(x => x.id === draft.id ? { ...x, ...payload } : x);
      else data.expenses.push({ id: uid('exp'), ...payload });
    });
    closeModal(); toast(draft.id ? 'Expense updated.' : 'Expense added.'); render({ preserveScroll: true }); return;
  }

  if (formId === 'settlement-form') {
    syncSettlementDraftFromForm();
    const draft = state.settlementDraft;
    const g = groupById(draft.groupId);
    const amount = Number(draft.amount);
    const errorEl = $('#settlement-error');
    const fail = msg => { if (errorEl) errorEl.textContent = msg; };
    if (!g) { fail('Choose a group.'); return; }
    if (draft.fromId === draft.toId) { fail('Choose two different members.'); return; }
    if (!(amount > 0)) { fail('Enter an amount greater than zero.'); return; }
    const net = netFor(store.data(), g.id);
    const debt = Math.max(0, -(net[draft.fromId] || 0));
    if (debt <= 0.004) { fail(`${memberName(g, draft.fromId)} has no outstanding balance in this group.`); return; }
    if (amount > debt + 0.011) { fail(`Amount cannot exceed ${fmt(debt)}, the total ${memberName(g, draft.fromId)} owes in this group.`); return; }
    store.updateData(d => {
      d.settlements.push({
        id: uid('set'), groupId: g.id, date: draft.date || dateInput(),
        fromId: draft.fromId, toId: draft.toId, amount: roundCents(amount), note: draft.note.trim(),
      });
    });
    closeModal(); toast('Settlement recorded.'); render({ preserveScroll: true }); return;
  }

  if (formId === 'endpoint-form') {
    const value = String($('#sync-endpoint-input')?.value || '');
    store.setSyncEndpoint(value);
    await checkCloud({ silent: true });
    if (store.authMode() === 'cloud' && state.cloud.phase === 'online') syncEventsForCurrentConfig();
    toast(state.cloud.available ? 'Endpoint saved and reachable.' : 'Endpoint saved, but cloud is unavailable.', state.cloud.available ? 'success' : 'error');
    render({ preserveScroll: true }); return;
  }

  if (formId === 'import-form') {
    const result = store.importData($('#import-json')?.value || '');
    if (!result.ok) { const err = $('#import-error'); if (err) err.textContent = result.error || 'Import failed.'; return; }
    closeModal(); toast('Tandem data imported.'); render({ preserveScroll: false }); return;
  }
});

/* --------------------------- inputs and keys --------------------------- */

function refocusAfterRender(id) {
  const el = $(`#${id}`);
  if (!el) return;
  el.focus();
  try { el.setSelectionRange(el.value.length, el.value.length); } catch { /* noop */ }
}

document.addEventListener('input', e => {
  const t = e.target;
  if (t.id === 'expense-search') {
    state.expenseFilter.search = t.value;
    render({ preserveScroll: true });
    refocusAfterRender('expense-search');
    return;
  }
  if (t.id === 'e-amount') {
    if (state.expenseDraft) { state.expenseDraft.amount = t.value; refreshSplitPreview(); }
    return;
  }
  if (t.dataset?.splitValue !== undefined && state.expenseDraft) {
    state.expenseDraft.values[t.dataset.splitValue] = t.value;
    refreshSplitPreview();
  }
});

document.addEventListener('change', async e => {
  const el = e.target;
  if (el.id === 'expense-group') {
    state.expenseFilter.group = el.value; render({ preserveScroll: true }); return;
  }
  if (el.id === 'balance-group') { state.balanceGroup = el.value; render({ preserveScroll: true }); return; }
  if (el.id === 'activity-group') { state.activityFilter.group = el.value; render({ preserveScroll: true }); return; }
  if (el.id === 'activity-type') { state.activityFilter.type = el.value; render({ preserveScroll: true }); return; }
  if (el.id === 'e-group') {
    syncExpenseDraftFromForm();
    const g = groupById(state.expenseDraft.groupId);
    if (g) { prepareDraftValues(g, state.expenseDraft); expenseModalPaint(); }
    return;
  }
  if (el.id === 'e-method') {
    syncExpenseDraftFromForm();
    const draft = state.expenseDraft;
    const g = groupById(draft.groupId);
    if (!g) return;
    if (draft.method === 'custom') {
      const parts = allocateCents(Number(draft.amount) || 0, g.members.map(() => 1));
      g.members.forEach((m, i) => { draft.values[m.id] = parts[i]; });
    } else {
      g.members.forEach(m => { draft.values[m.id] = 1; });
    }
    expenseModalPaint();
    return;
  }
  if (el.id === 's-group') {
    syncSettlementDraftFromForm();
    const draft = state.settlementDraft;
    const g = groupById(draft.groupId);
    if (g) {
      draft.fromId = g.members[0]?.id || '';
      draft.toId = g.members.find(m => m.id !== draft.fromId)?.id || '';
      draft.amount = '';
      settlementModalPaint();
    }
    return;
  }
  if (el.id === 's-from' || el.id === 's-to' || el.id === 's-amount') {
    syncSettlementDraftFromForm();
    updateSettlementHint();
    return;
  }
  if (el.id === 'theme-select') {
    store.setPref('theme', el.value); applyTheme(); render({ preserveScroll: true });
    const again = $('#theme-select'); if (again) again.focus();
    return;
  }
  if (el.id === 'currency-select') {
    store.setPref('currency', el.value); toast(`Display currency set to ${el.value}.`); render({ preserveScroll: true });
    const again = $('#currency-select'); if (again) again.focus();
    return;
  }
  if (el.id === 'import-file' && el.files?.[0]) {
    try {
      const text = await el.files[0].text();
      const area = $('#import-json');
      if (area) area.value = text;
    } catch { toast('Could not read that file.', 'error'); }
  }
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (modalHost.innerHTML) closeModal();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && route().page === 'expenses') {
    const input = $('#expense-search');
    if (input) { e.preventDefault(); input.focus(); }
  }
});

window.addEventListener('hashchange', () => { closeModal(); render({ preserveScroll: false }); });

/* ---------------------------------- boot ---------------------------------- */

async function boot() {
  applyTheme();
  initCalendarWidget({ app: 'tandem', getEndpoint: getSyncEndpoint, getToken: cloudToken });
  render({ preserveScroll: false });
  await checkCloud({ silent: true });
  if (store.authMode() === 'cloud') {
    state.syncReady = false;
    const res = await api.me();
    if (!res.ok) {
      toast('Cloud session expired — switched to local-only mode.', 'error');
      stopEvents(); store.signOut();
      state.cloud.status = 'offline';
    } else {
      store.refreshCloudUser(res.data?.user || store.currentUser());
      await hydrateCloud();
      state.syncReady = true;
      syncEventsForCurrentConfig();
    }
  }
  paintSyncStatus();
  render({ preserveScroll: true });
  if (store.currentUser() && !store.getPrefs().onboardingComplete && route().mode === 'app') {
    prepareOnboarding('Finish setup to personalize Tandem.');
  }
}

boot();




