/* Airo Finance — view layer, routing and interactions.
   Everything renders from local state; no framework, no bundler. */
import {
  BRAND, ROUTES, PAGE_TITLES, CURRENCIES, ACCOUNT_TYPES, TRANSACTION_TYPES,
  BUDGET_PERIODS, FREQUENCIES, FREQUENCY_FACTOR, CATEGORIES, CATEGORY_COLORS,
  ACCOUNT_COLORS, CHART_COLORS, STORAGE, SYNC_APP, MERIDIAN_APP,
  RETIREMENT_TYPES, RETIREMENT_STATUSES,
} from './config.js';
import * as store from './store.js';
import { getSyncEndpoint, cloudToken } from './store.js';
import * as api from './api.js';
import { initCalendarWidget } from './calendar-widget.js';
import { lineChart, donut, bars, attachChartHover } from './charts.js';
import {
  $, $$, esc, money, num, signClass, uid, colorFor, safeColor, dateInput,
  addDays, dateLabel, initials, safeParse, debounce, monthKey, monthLabel,
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
    theme: 'light', currency: 'USD', starterType: 'budget',
    category: 'Groceries', accountName: '', institution: '',
  },
  txFilter: { search: '', account: 'all', category: 'all', type: 'all' },
  retirementFilter: { type: 'all', status: 'all' },
  connectorCode: null,
  syncReady: false,
  eventSub: null,
  eventToken: null,
  eventEndpoint: null,
};

/* ------------------------------ helpers ------------------------------ */

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
  const theme = store.getPrefs().theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#080e19' : '#f5f8fc');
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

function effectiveAmount(tx) {
  const a = Math.abs(Number(tx?.amount) || 0);
  return tx?.type === 'income' ? a : tx?.type === 'expense' ? -a : 0;
}

function sortedTransactions(d) {
  return [...d.transactions].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
}

function budgetSpent(budget, d = store.data()) {
  const today = new Date();
  const todayStr = dateInput(today);
  let rows;
  if (budget.period === 'weekly') {
    const start = dateInput(addDays(today, -6));
    rows = d.transactions.filter(t => String(t.date) >= start && String(t.date) <= todayStr);
  } else {
    const key = monthKey(today);
    rows = d.transactions.filter(t => String(t.date || '').slice(0, 7) === key);
  }
  return rows.filter(t => t.type === 'expense' && t.category === budget.category)
    .reduce((s, t) => s + Math.abs(Number(t.amount) || 0), 0);
}

function metrics(d = store.data()) {
  const active = d.accounts.filter(a => !a.archived);
  const netWorth = active.reduce((s, a) => s + (Number(a.balance) || 0), 0);
  const key = monthKey();
  const month = d.transactions.filter(t => String(t.date || '').slice(0, 7) === key);
  const income = month.filter(t => t.type === 'income').reduce((s, t) => s + Math.abs(Number(t.amount) || 0), 0);
  const expense = month.filter(t => t.type === 'expense').reduce((s, t) => s + Math.abs(Number(t.amount) || 0), 0);
  const savingsRate = income > 0 ? (income - expense) / income * 100 : 0;
  const byCategory = {};
  month.filter(t => t.type === 'expense').forEach(t => {
    const cat = t.category || 'Other';
    byCategory[cat] = (byCategory[cat] || 0) + Math.abs(Number(t.amount) || 0);
  });
  const spend = Object.entries(byCategory).map(([label, value], i) => ({
    label, value, color: CATEGORY_COLORS[i % CATEGORY_COLORS.length],
  })).sort((a, b) => b.value - a.value);

  const cashflow = [];
  const base = new Date();
  for (let i = 5; i >= 0; i--) {
    const d0 = new Date(base.getFullYear(), base.getMonth() - i, 1);
    const k = monthKey(d0);
    const rows = d.transactions.filter(t => String(t.date || '').slice(0, 7) === k);
    const inc = rows.filter(t => t.type === 'income').reduce((s, t) => s + Math.abs(Number(t.amount) || 0), 0);
    const exp = rows.filter(t => t.type === 'expense').reduce((s, t) => s + Math.abs(Number(t.amount) || 0), 0);
    cashflow.push({ date: monthLabel(k), value: Math.round((inc - exp) * 100) / 100 });
  }
  return { netWorth, income, expense, savingsRate, spend, cashflow, accountCount: active.length };
}

function runningBalances(d) {
  const map = {};
  d.accounts.forEach(a => {
    const rows = d.transactions.filter(t => t.accountId === a.id)
      .sort((x, y) => String(x.date || '').localeCompare(String(y.date || '')));
    const net = rows.reduce((s, t) => s + effectiveAmount(t), 0);
    let bal = (Number(a.balance) || 0) - net;
    rows.forEach(t => { bal += effectiveAmount(t); map[t.id] = bal; });
  });
  return map;
}

function recurringInfo(r) {
  const amount = Math.abs(Number(r?.amount) || 0);
  const factor = FREQUENCY_FACTOR[r?.frequency] || 12;
  return { annual: amount * factor, monthly: amount * factor / 12 };
}

function meridianParts(d) {
  const raw = d.meridian;
  const envelope = raw?.data && typeof raw.data === 'object' ? raw : { data: raw };
  const payload = envelope.data || {};
  const body = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
  return {
    holdings: Array.isArray(body?.holdings) ? body.holdings : [],
    watchlist: Array.isArray(body?.watchlist) ? body.watchlist : [],
    goals: Array.isArray(body?.goals) ? body.goals : [],
    updatedAt: envelope.updatedAt || payload.updatedAt || null,
  };
}

function insightsFor(d) {
  const m = metrics(d);
  const top = m.spend[0] || null;
  const annual = d.recurring.reduce((s, r) => s + recurringInfo(r).annual, 0);
  const largest = [...d.recurring].sort((a, b) => recurringInfo(b).annual - recurringInfo(a).annual)[0] || null;
  const budgets = d.budgets.map(b => ({ ...b, spent: budgetSpent(b, d) }));
  const healthy = budgets.filter(b => b.spent <= Number(b.limit || 0)).length;
  const retirement = retirementTotals(d);
  const largestRetirement = [...retirement.rows].sort((a, b) => (Number(b.balance) || 0) - (Number(a.balance) || 0))[0] || null;
  return { m, top, annual, largest, budgets, healthy, retirement, largestRetirement };
}

function filteredTransactions(d) {
  const f = state.txFilter;
  const q = String(f.search || '').trim().toLowerCase();
  return sortedTransactions(d).filter(t => {
    if (f.account !== 'all' && t.accountId !== f.account) return false;
    if (f.category !== 'all' && (t.category || 'Other') !== f.category) return false;
    if (f.type !== 'all' && t.type !== f.type) return false;
    if (q && !`${t.description || ''} ${t.category || ''} ${t.date || ''}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

function retirementLabel(type) {
  return RETIREMENT_TYPES.find(t => t.value === type)?.label || 'Other';
}

function retirementStatusLabel(status) {
  return RETIREMENT_STATUSES.find(s => s.value === status)?.label || 'Active';
}

function retirementTotals(d) {
  const rows = Array.isArray(d?.retirementAccounts) ? d.retirementAccounts : [];
  return {
    rows,
    balance: rows.reduce((s, a) => s + (Number(a.balance) || 0), 0),
    employeeYTD: rows.reduce((s, a) => s + (Number(a.employeeYTD) || 0), 0),
    employerYTD: rows.reduce((s, a) => s + (Number(a.employerYTD) || 0), 0),
    activeCount: rows.filter(a => a.status === 'active').length,
  };
}

function retirementAllocation(rows) {
  const totals = new Map();
  rows.forEach(a => {
    const key = a.type || 'other';
    totals.set(key, (totals.get(key) || 0) + (Number(a.balance) || 0));
  });
  return [...totals.entries()]
    .map(([type, value], i) => ({ label: retirementLabel(type), value, color: CHART_COLORS[i % CHART_COLORS.length] }))
    .sort((a, b) => b.value - a.value);
}

function filteredRetirement(d) {
  const f = state.retirementFilter;
  const rows = Array.isArray(d?.retirementAccounts) ? d.retirementAccounts : [];
  return rows.filter(a => {
    if (f.type !== 'all' && (a.type || 'other') !== f.type) return false;
    if (f.status !== 'all' && (a.status || 'active') !== f.status) return false;
    return true;
  });
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

function stripClientId(remote) {
  const clean = store.sanitizeData(remote);
  delete clean.settings.syncClientId;
  return clean;
}

function readRemoteData(res) {
  if (!res.ok || !res.data || typeof res.data !== 'object') return null;
  const body = res.data.data && typeof res.data.data === 'object' ? res.data.data : null;
  return { body, updatedAt: Date.parse(res.data.updatedAt) || 0 };
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
  if (!remote?.body) {
    // No snapshot on the server yet: the next local change seeds it.
    return;
  }
  const meta = store.getSyncMeta();
  const isOwnWrite = remote.body.settings?.syncClientId === store.clientId();
  if (!isOwnWrite && (remote.updatedAt > (meta.remoteAt || 0) || !store.getPrefs().onboardingComplete)) {
    const clean = stripClientId(remote.body);
    const localSettings = store.data().settings;
    clean.settings.cloudToken = localSettings.cloudToken || '';
    if (localSettings.meridianToken) clean.settings.meridianToken = localSettings.meridianToken;
    else delete clean.settings.meridianToken;
    store.replaceData(clean, 'remote');
  }
  store.setSyncMeta({ remoteAt: Math.max(remote.updatedAt, meta.remoteAt || 0), lastSync: Date.now() });
  state.cloud.lastSync = Date.now();
  state.cloud.status = 'live';
  paintSyncStatus();
}

async function pushSnapshotNow(payload) {
  const token = store.cloudToken();
  if (!token || state.cloud.phase !== 'online') return;
  const clean = store.sanitizeData(payload || store.data());
  clean.settings.cloudToken = '';
  delete clean.settings.meridianToken;
  delete clean.settings.syncClientId;
  const enriched = { ...clean, settings: { ...clean.settings, syncClientId: store.clientId() } };
  const res = await api.putSnapshot(SYNC_APP, enriched, token);
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

const schedulePush = debounce(data => pushSnapshotNow(data), 1200);

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

/* Recreate the EventSource only when the token or endpoint actually changed. */
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
    if (payload.app === SYNC_APP) {
      const remote = readRemoteData(await api.getSnapshot(SYNC_APP));
      if (!remote?.body) return;
      const at = remote.updatedAt || Date.now();
      if (remote.body.settings?.syncClientId === store.clientId()) {
        store.setSyncMeta({ remoteAt: at, lastSync: Date.now() });
        state.cloud.lastSync = Date.now();
        paintSyncStatus();
        return;
      }
      store.setSyncMeta({ remoteAt: at, lastSync: Date.now() });
      const clean = stripClientId(remote.body);
      const localSettings = store.data().settings;
      clean.settings.cloudToken = localSettings.cloudToken || '';
      if (localSettings.meridianToken) clean.settings.meridianToken = localSettings.meridianToken;
      else delete clean.settings.meridianToken;
      store.replaceData(clean, 'remote');
      state.cloud.lastSync = Date.now();
      paintSyncStatus();
      render({ preserveScroll: true });
      toast('Latest changes loaded from cloud.');
    } else if (payload.app === MERIDIAN_APP) {
      const meridianToken = store.data().settings.meridianToken || store.cloudToken();
      const res = await api.getSnapshot(MERIDIAN_APP, meridianToken);
      if (!res.ok || !res.data?.data) return;
      store.updateData(d => {
        d.meridian = res.data;
        d.settings.linkedMeridian = true;
      }, { source: 'remote' });
      if (route().page === 'connector') render({ preserveScroll: true });
      toast('Meridian snapshot updated.');
    }
  } catch { /* stream events are best-effort */ }
}

store.subscribe((data, meta) => {
  if (meta.source === 'local' && state.syncReady) schedulePush(data);
  // Any credential or endpoint change must replace the live EventSource.
  if (store.authMode() === 'cloud') syncEventsForCurrentConfig();
  else if (state.eventSub) stopEvents();
});

/* ------------------------------- landing ------------------------------- */

function brandMarkup(small = false) {
  return `<span class="brand"><span class="brand-mark">A</span><span class="brand-name">${esc(BRAND.product)}${small ? '' : `<span class="brand-sub">by ${esc(BRAND.legal)}</span>`}</span></span>`;
}

function landing() {
  const trend = 'M4,124 L42,116 L80,121 L118,96 L156,104 L194,72 L232,80 L270,48 L308,58 L346,26 L384,34 L422,12 L460,20 L496,6';
  return `<div class="landing">
    <div class="nav-wrap"><nav class="nav">
      ${brandMarkup()}
      <div class="nav-links"><a href="#features">Features</a><a href="#approach">Our approach</a><a href="#connect">Connector</a></div>
      <div class="nav-actions">
        <button class="btn btn-icon btn-ghost" data-action="toggle-theme" title="Toggle theme">${store.getPrefs().theme === 'light' ? '◐' : '☀'}</button>
        <a class="btn btn-ghost btn-sm" href="${ROUTES.signin}">Sign in</a>
        <a class="btn btn-primary btn-sm" href="${ROUTES.signup}">Get started →</a>
      </div>
    </nav></div>

    <header class="hero">
      <div>
        <span class="eyebrow"><span class="pulse-dot"></span> A product of ${esc(BRAND.legal)}</span>
        <h1>Money, <em>made clear.</em></h1>
        <p class="hero-copy">Budgets, accounts, cashflow and goals in one calm workspace. See where your money goes, plan what comes next, and connect Meridian — without handing over a single bank password.</p>
        <div class="hero-ctas">
          <a class="btn btn-primary btn-lg" href="${ROUTES.signup}">Start for free →</a>
          <a class="btn btn-lg" href="${ROUTES.signin}">I already have an account</a>
        </div>
        <div class="hero-note"><span>✓ Manual accounts</span><span>✓ Local-first data</span><span>✓ Optional cloud sync</span></div>
      </div>
      <div class="hero-visual">
        <div class="hero-glow"></div>
        <div class="mock-card">
          <div class="mock-top"><span>Net worth · this month</span><span class="tag-pill">All accounts</span></div>
          <div class="mock-value">$24,860.42</div>
          <div class="mock-change">↗ +$1,284.10 vs last month</div>
          <div class="mock-chart">
            <svg viewBox="0 0 500 140" preserveAspectRatio="none" aria-hidden="true">
              <defs><linearGradient id="airoMock" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#3b82f6" stop-opacity=".32"/><stop offset="100%" stop-color="#3b82f6" stop-opacity="0"/></linearGradient></defs>
              <path d="${trend} L496,140 L4,140 Z" fill="url(#airoMock)"/>
              <path d="${trend}" fill="none" stroke="#3b82f6" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </div>
          <div class="mock-rows">
            <div class="mock-row"><span class="sym"><span class="sym-badge" style="background:#3b82f6">G</span> Groceries</span><b>$482.20 / $600</b></div>
            <div class="mock-row"><span class="sym"><span class="sym-badge" style="background:#14b8a6">D</span> Dining</span><b>$184.00 / $250</b></div>
            <div class="mock-row"><span class="sym"><span class="sym-badge" style="background:#d9b66c">S</span> Savings goal</span><b>72% complete</b></div>
          </div>
        </div>
        <div class="float-chip one"><span class="dot"></span> Budgets on track</div>
        <div class="float-chip two">◈ Meridian snapshot linked</div>
      </div>
    </header>

    <div class="ticker-band"><div class="ticker-track">
      ${['BUDGETS', 'CASHFLOW', 'MANUAL ACCOUNTS', 'RECURRING BILLS', 'GOALS', 'MERIDIAN CONNECTOR', 'INSIGHTS'].map(x => `<span class="ticker-item"><b>✦</b>${x}</span>`).join('')}
      ${['BUDGETS', 'CASHFLOW', 'MANUAL ACCOUNTS', 'RECURRING BILLS', 'GOALS', 'MERIDIAN CONNECTOR', 'INSIGHTS'].map(x => `<span class="ticker-item"><b>✦</b>${x}</span>`).join('')}
    </div></div>

    <section class="section" id="features">
      <div class="section-head"><span class="eyebrow">Everything in its place</span>
        <h2>Quiet tools for a clearer money life.</h2>
        <p>Airo keeps the useful parts of personal finance — the numbers, the trends and the next step — and leaves the noise behind.</p>
      </div>
      <div class="feature-grid">
        <article class="feature"><div class="feature-icon">◫</div><h3>Budgets that talk straight</h3><p>Set weekly or monthly limits, watch spending fill the bar, and know instantly when a category is over.</p></article>
        <article class="feature"><div class="feature-icon">↗</div><h3>Money tracking</h3><p>Record income, expenses and transfers. Filter by account or category and see a running balance on every row.</p></article>
        <article class="feature"><div class="feature-icon">▤</div><h3>Manual accounts</h3><p>Add checking, savings, cards and investments by hand. Clean balances and totals — no bank login required.</p></article>
        <article class="feature"><div class="feature-icon">◇</div><h3>Meridian Connector</h3><p>Redeem a six-digit code to bring a Meridian snapshot of holdings, watchlist and goals into Airo.</p></article>
        <article class="feature"><div class="feature-icon">◉</div><h3>Deterministic insights</h3><p>Top spending category, savings rate, largest recurring cost and budget health — calculated locally, no AI provider.</p></article>
        <article class="feature"><div class="feature-icon">◈</div><h3>Private by default</h3><p>Local accounts use salted PBKDF2 hashing. Cloud sync is optional and can be turned off at any time.</p></article>
      </div>
    </section>

    <section class="section" id="approach" style="padding-top:0">
      <div class="split-section">
        <div>
          <span class="eyebrow">Honest by design</span>
          <h2>Real clarity starts with knowing what a tool cannot do.</h2>
          <p style="color:var(--muted);margin-top:16px">Airo accounts are manual records. There are no bank credentials stored here, no account aggregation, and no silent connection to your bank. If you want an investing view, Meridian handles that — and the Connector brings the snapshot across.</p>
          <div class="asset-cloud"><span class="asset-chip"><b>Checking</b></span><span class="asset-chip"><b>Savings</b></span><span class="asset-chip"><b>Cards</b></span><span class="asset-chip"><b>Investments</b></span><span class="asset-chip"><b>Cash</b></span></div>
        </div>
        <div class="card">
          <div class="card-head"><h3>How it works</h3><span class="tag-pill">3 steps</span></div>
          <div class="step-list">
            <div class="step"><b>1</b><div><strong>Create a workspace</strong><p>Use cloud sign-in when the sync service is available, or a private account in this browser.</p></div></div>
            <div class="step"><b>2</b><div><strong>Add your money manually</strong><p>Name each account, choose a type and color, and enter the current balance you see.</p></div></div>
            <div class="step"><b>3</b><div><strong>Plan and review</strong><p>Budgets, recurring bills, goals and insights update from the numbers you record.</p></div></div>
          </div>
        </div>
      </div>
    </section>

    <section class="section" id="connect" style="padding-top:0">
      <div class="cta-band">
        <span class="eyebrow">Ready when you are</span>
        <h2>Money, made clear.</h2>
        <p>Start with one account and one budget. Everything else can wait.</p>
        <div class="btn-row" style="justify-content:center">
          <a class="btn btn-primary btn-lg" href="${ROUTES.signup}">Create your workspace →</a>
          <a class="btn btn-lg" href="${ROUTES.signin}">Sign in</a>
        </div>
      </div>
    </section>

    <footer class="landing-footer"><div class="footer-inner">
      <div>${brandMarkup()}<p>${esc(BRAND.dba)} is a registered trade name (DBA) of ${esc(BRAND.legal)}. Manual account records only — bank login and aggregation are not enabled. Informational only; not financial advice.</p></div>
      <div class="footer-links"><a href="#features">Features</a><a href="#connect">Connector</a><a href="${ROUTES.signin}">Sign in</a><a href="${ROUTES.signup}">Get started</a></div>
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
    <span class="txt"><b>${backend === 'cloud' ? 'Cloud account' : 'Local account'}</b>
      <span>${backend === 'cloud' ? 'Syncs through Atlas Sync when reachable.' : 'Stored only in this browser with PBKDF2 hashing.'}</span></span>
    <span class="mode-switch">
      <button type="button" class="${backend === 'cloud' ? 'active' : ''}" data-action="set-auth-backend" data-backend="cloud" ${available ? '' : 'disabled title="Cloud endpoint unavailable"'}>Cloud</button>
      <button type="button" class="${backend === 'local' ? 'active' : ''}" data-action="set-auth-backend" data-backend="local">Browser</button>
    </span>
  </div>`;

  return `<div class="auth-page">
    <div class="auth-form-side"><div class="auth-box">
      <a href="${ROUTES.landing}">${brandMarkup()}</a>
      <h1 style="margin-top:28px">${isSignup ? 'Create your workspace' : 'Welcome back'}</h1>
      <p class="sub">${isSignup ? 'A clear view of your money takes about two minutes.' : 'Sign in to pick up where you left off.'}</p>
      ${modeChip}
      <form id="${isSignup ? 'signup-form' : 'signin-form'}" autocomplete="on">
        ${isSignup ? `<div class="field"><label for="auth-name">Your name</label><input class="input" id="auth-name" name="name" autocomplete="name" placeholder="Alex Morgan" required/></div>` : ''}
        <div class="field"><label for="auth-email">Email address</label><input class="input" id="auth-email" name="email" type="email" autocomplete="email" placeholder="you@example.com" required/></div>
        <div class="field"><label for="auth-password">Password</label><input class="input" id="auth-password" name="password" type="password" autocomplete="${isSignup ? 'new-password' : 'current-password'}" placeholder="At least 8 characters" required/></div>
        <div class="form-error" id="auth-error"></div>
        <button class="btn btn-primary btn-lg" type="submit" style="width:100%">${isSignup ? 'Create account →' : 'Sign in →'}</button>
      </form>
      <div class="auth-switch">${isSignup ? 'Already have an account? ' : 'New to Airo? '}
        <a href="${isSignup ? ROUTES.signin : ROUTES.signup}">${isSignup ? 'Sign in' : 'Create one'}</a></div>
      <p class="data-note">${available ? 'Cloud endpoint reachable.' : `Cloud endpoint unavailable — using local mode. <button type="button" class="btn btn-sm btn-ghost" data-action="retry-cloud">Retry</button>`}</p>
    </div></div>
    <div class="auth-art">
      <span class="eyebrow">${esc(BRAND.dba)}</span>
      <h2>${esc(BRAND.tagline)}</h2>
      <p>One workspace for the accounts you manage yourself, the budgets you actually follow, and the Meridian snapshot you already trust.</p>
      <div class="auth-points">
        <div class="auth-point"><span style="color:var(--mint)">✓</span><span>Manual accounts with clear balances and totals by type.</span></div>
        <div class="auth-point"><span style="color:var(--mint)">✓</span><span>Budgets, recurring bills and goals in a single plan.</span></div>
        <div class="auth-point"><span style="color:var(--mint)">✓</span><span>No bank credentials, no OAuth, no aggregation.</span></div>
      </div>
    </div>
  </div>`;
}

function prepareOnboarding(message) {
  state.onboarding = {
    theme: store.getPrefs().theme || 'light', currency: store.getPrefs().currency || 'USD',
    starterType: 'budget', category: 'Groceries', accountName: '', institution: '',
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
      prepareOnboarding(kind === 'signup' ? 'Account created. Let’s personalize Airo.' : 'Welcome back — finish setup to continue.');
      return;
    }
    toast(`Welcome back, ${user?.name || 'there'}.`);
    go(ROUTES.overview);
  } finally {
    if (submit) submit.disabled = false;
  }
}

/* ----------------------------- onboarding ----------------------------- */

function readOnboardFields() {
  const currencyEl = $('#on-currency');
  const categoryEl = $('#on-category');
  const nameEl = $('#on-account-name');
  const instEl = $('#on-institution');
  if (currencyEl) state.onboarding.currency = currencyEl.value;
  if (categoryEl) state.onboarding.category = categoryEl.value;
  if (nameEl) state.onboarding.accountName = nameEl.value;
  if (instEl) state.onboarding.institution = instEl.value;
}

function onboardingModal() {
  const o = state.onboarding;
  openModal(`<div class="onboarding-head"><span class="eyebrow">First steps</span>
    <h2 style="font-size:26px;margin-top:12px">Make Airo yours</h2>
    <p class="muted small" style="margin-top:6px">Three quick choices. You can change all of them later in Settings.</p></div>
    <form id="onboarding-form">
      <div class="onboard-section">
        <div class="onboard-label"><b>1</b><span>Choose a theme</span></div>
        <div class="theme-choices">
          <button type="button" class="theme-choice ${active(o.theme, 'light')}" data-action="onboard-theme" data-theme="light">
            <span class="theme-preview light"><i></i><i></i><i></i></span><span class="theme-icon">☀</span>
            <strong>Daylight</strong><small>Warm, paper-like and easy on the eyes.</small></button>
          <button type="button" class="theme-choice ${active(o.theme, 'dark')}" data-action="onboard-theme" data-theme="dark">
            <span class="theme-preview dark"><i></i><i></i><i></i></span><span class="theme-icon">◐</span>
            <strong>Nightfall</strong><small>Deep navy with calm, precise contrast.</small></button>
        </div>
      </div>
      <div class="onboard-section">
        <div class="onboard-label"><b>2</b><span>Base currency</span></div>
        <div class="field"><label for="on-currency">Display currency for all amounts</label>
          <select class="input" id="on-currency">${CURRENCIES.map(c => `<option value="${esc(c)}" ${selected(c, o.currency)}>${esc(c)}</option>`).join('')}</select></div>
      </div>
      <div class="onboard-section">
        <div class="onboard-label"><b>3</b><span>Start with something useful</span></div>
        <div class="starter-choices">
          <button type="button" class="starter-choice ${active(o.starterType, 'budget')}" data-action="onboard-type" data-type="budget"><strong>A starter budget</strong><small>A monthly category with a $300 limit.</small></button>
          <button type="button" class="starter-choice ${active(o.starterType, 'account')}" data-action="onboard-type" data-type="account"><strong>A manual account</strong><small>Record an account you already manage.</small></button>
        </div>
        ${o.starterType === 'budget'
          ? `<div class="field" style="margin-top:14px"><label for="on-category">Budget category</label><select class="input" id="on-category">
              <option value="none">Skip for now</option>${CATEGORIES.filter(c => !['Income', 'Transfer'].includes(c)).map(c => `<option value="${esc(c)}" ${selected(c, o.category)}>${esc(c)}</option>`).join('')}</select></div>`
          : `<div class="form-grid" style="margin-top:14px">
              <div class="field"><label for="on-account-name">Account name</label><input class="input" id="on-account-name" placeholder="Everyday checking" value="${esc(o.accountName)}"/></div>
              <div class="field"><label for="on-institution">Institution</label><input class="input" id="on-institution" placeholder="Manual entry" value="${esc(o.institution)}"/></div></div>`}
      </div>
      <div class="modal-actions"><button class="btn btn-primary" type="submit">Open my workspace →</button></div>
    </form>`);
}

function finishOnboarding() {
  readOnboardFields();
  const o = state.onboarding;
  store.updateData(d => {
    d.settings.theme = o.theme;
    d.settings.currency = o.currency;
    d.settings.name = d.settings.name || store.currentUser()?.name || '';
    d.settings.onboardingComplete = true;
    if (o.starterType === 'budget' && o.category && o.category !== 'none') {
      d.budgets.push({ id: uid('bud'), category: o.category, limit: 300, period: 'monthly' });
    }
    if (o.starterType === 'account' && String(o.accountName || '').trim()) {
      d.accounts.push({
        id: uid('acc'), name: String(o.accountName).trim(),
        institution: String(o.institution || 'Manual entry').trim(), type: 'Checking', mask: '',
        balance: 0, color: ACCOUNT_COLORS[0], archived: false,
      });
    }
  });
  closeModal();
  applyTheme();
  toast('You’re all set.');
  go(ROUTES.overview);
}

/* -------------------------------- shell -------------------------------- */

function navItem(page, icon, label) {
  const activePage = route().mode === 'app' && route().page === page;
  return `<a class="nav-item ${activePage ? 'active' : ''}" href="#/app/${page}" title="${esc(label)}"><span class="ico">${icon}</span><span class="label">${esc(label)}</span></a>`;
}

function sidebar() {
  const user = store.currentUser() || {};
  return `<aside class="sidebar">
    ${brandMarkup(true)}
    <div><p class="nav-group-label">Everyday</p><nav class="side-nav">
      ${navItem('overview', '◫', 'Overview')}
      ${navItem('accounts', '▤', 'Accounts')}
      ${navItem('transactions', '↔', 'Transactions')}
      ${navItem('budgets', '◈', 'Budgets')}
    </nav></div>
    <div><p class="nav-group-label">Plan & connect</p><nav class="side-nav">
      ${navItem('recurring', '⟳', 'Recurring')}
      ${navItem('goals', '◎', 'Goals')}
      ${navItem('retirement', '◴', 'Retirement')}
      ${navItem('insights', '✦', 'Insights')}
      ${navItem('connector', '◇', 'Meridian')}
      ${navItem('settings', '⚙', 'Settings')}
    </nav></div>
    <div class="sidebar-bottom">
      <div class="side-account"><span class="avatar">${esc(initials(user.name || 'Airo user'))}</span>
        <span class="details"><span class="name">${esc(user.name || 'Airo user')}</span><span class="mail">${esc(user.email || '')}</span></span></div>
      <p class="side-note">${esc(BRAND.dba)} · DBA of ${esc(BRAND.legal)}. Manual accounts only.</p>
    </div>
  </aside>`;
}

function topbar(page) {
  const info = statusInfo();
  return `<header class="topbar">
    <button class="btn btn-icon btn-ghost mobile-menu" data-action="toggle-mobile-nav" title="Navigation">☰</button>
    <div class="page-title"><h1>${esc(PAGE_TITLES[page] || 'Overview')}</h1><p>${esc(BRAND.tagline)}</p></div>
    <div class="topbar-right">
      <div class="status-pill ${info.cls}" title="Cloud sync status"><span class="status-dot"></span><span class="status-text" data-sync-status>${esc(info.text)}</span></div>
      <button class="btn btn-icon btn-ghost" data-action="toggle-theme" title="Toggle theme">${store.getPrefs().theme === 'light' ? '◐' : '☀'}</button>
      <button class="btn btn-primary btn-sm" data-action="add-transaction">＋ Add money</button>
    </div>
  </header>`;
}

function bannerMarkup() {
  if (state.cloud.phase !== 'offline' || state.cloud.bannerDismissed) return '';
  return `<div class="banner"><span class="ic">⚠</span>
    <span class="txt"><b>Cloud sync is unavailable.</b> Airo is working in local-only mode — your data stays in this browser. ${esc(state.cloud.error || '')}</span>
    <button class="btn btn-sm" data-action="retry-cloud">Retry</button>
    <button class="btn btn-sm btn-ghost" data-action="dismiss-banner">Dismiss</button></div>`;
}

function pageHead(title, subtitle, button = '') {
  return `<div class="page-head"><div><h1>${esc(title)}</h1><p>${esc(subtitle)}</p></div>${button}</div>`;
}

/* ------------------------------- overview ------------------------------- */

function recentRows(rows, d, map, showBalance = false) {
  if (!rows.length) return '';
  return rows.map(t => {
    const acc = d.accounts.find(a => a.id === t.accountId);
    const amount = (Number(t.amount) || 0) * (t.type === 'income' ? 1 : -1);
    const bal = map[t.id];
    return `<tr>
      <td><div class="sym-cell"><span class="sym-logo" style="background:${esc(safeColor(acc?.color))}">${esc((acc?.name || '?')[0].toUpperCase())}</span>
        <span><strong>${esc(t.description || 'Untitled transaction')}</strong><small>${esc(dateLabel(t.date, { short: true }))} · ${esc(acc?.name || 'Unassigned')}</small></span></div></td>
      <td><span class="tag-pill">${esc(t.category || 'Other')}</span></td>
      <td><span class="badge ${t.type === 'income' ? 'up' : t.type === 'expense' ? 'down' : 'neutral'}">${esc(t.type)}</span></td>
      <td class="${signClass(amount)}">${esc(fmt(amount))}</td>
      ${showBalance ? `<td class="muted">${bal != null ? esc(fmt(bal)) : '—'}</td>` : ''}
      <td><div class="row-actions">
        <button class="btn btn-sm" data-action="edit-transaction" data-id="${esc(t.id)}">Edit</button>
        <button class="btn btn-sm btn-danger" data-action="delete-transaction" data-id="${esc(t.id)}">✕</button>
      </div></td>
    </tr>`;
  }).join('');
}

function overviewView(d) {
  const m = metrics(d);
  const retirement = retirementTotals(d);
  const map = runningBalances(d);
  const budgets = [...d.budgets].map(b => ({ ...b, spent: budgetSpent(b, d) })).slice(0, 4);
  const meridian = d.settings.linkedMeridian ? meridianParts(d) : null;
  const donutSegments = m.spend.slice(0, 6);

  return `${pageHead('Your money at a glance', 'A calm summary of where things stand today.', `<button class="btn btn-primary" data-action="add-account">＋ Add account</button>`)}
    <div class="grid grid-4" style="margin-bottom:18px">
      <div class="card stat-card"><div class="stat-label">Net worth</div><div class="stat-value">${esc(fmt(m.netWorth))}</div><div class="stat-foot">${m.accountCount} active account${m.accountCount === 1 ? '' : 's'}</div></div>
      <div class="card stat-card"><div class="stat-label">Income this month</div><div class="stat-value up">${esc(fmt(m.income))}</div><div class="stat-foot">${esc(monthLabel(monthKey(), true))}</div></div>
      <div class="card stat-card"><div class="stat-label">Spending this month</div><div class="stat-value down">${esc(fmt(m.expense))}</div><div class="stat-foot">Across ${m.spend.length} categories</div></div>
      <div class="card stat-card"><div class="stat-label">Savings rate</div><div class="stat-value">${esc(m.income ? `${m.savingsRate.toFixed(1)}%` : '—')}</div><div class="stat-foot">${m.income ? 'Income minus spending' : 'Add income to calculate'}</div></div>
    </div>

    <div class="grid grid-main" style="margin-bottom:18px">
      <div class="card">
        <div class="card-head"><div><h3>Cashflow · last 6 months</h3><div class="card-sub">Income minus expenses, month by month</div></div><span class="tag-pill">Monthly</span></div>
        ${lineChart(m.cashflow, { currency: currency(), height: 230, color: '#3b82f6', label: 'Monthly cashflow' })}
      </div>
      <div class="card">
        <div class="card-head"><div><h3>Spend by category</h3><div class="card-sub">This month</div></div></div>
        ${donutSegments.length
          ? `<div style="display:flex;gap:20px;align-items:center;flex-wrap:wrap">
              ${donut(donutSegments, { size: 168, label: 'Spent', value: fmt(m.expense, 0) })}
              <div class="legend" style="flex:1;min-width:130px">${donutSegments.map(s => `<div class="legend-item"><span class="legend-dot" style="background:${esc(s.color)}"></span><span class="nm">${esc(s.label)}</span><b>${esc(fmt(s.value, 0))}</b></div>`).join('')}</div>
            </div>`
          : emptyState('◔', 'No spending recorded', 'Add an expense transaction to see your category mix.')}
      </div>
    </div>

    <div class="grid grid-main">
      <div class="card">
        <div class="card-head"><div><h3>Recent transactions</h3><div class="card-sub">Newest first</div></div>
          <a class="btn btn-sm" href="${ROUTES.transactions}">View all →</a></div>
        ${d.transactions.length
          ? `<div class="table-scroll"><table class="data"><thead><tr><th>Transaction</th><th>Category</th><th>Type</th><th>Amount</th><th>Running balance</th><th>Actions</th></tr></thead><tbody>${recentRows(sortedTransactions(d).slice(0, 6), d, map, true)}</tbody></table></div>`
          : emptyState('↔', 'Nothing to show yet', 'Record your first transaction to start the story.', `<button class="btn btn-primary btn-sm" data-action="add-transaction">Add transaction</button>`)}
      </div>
      <div class="stack">
        <div class="card">
          <div class="card-head"><div><h3>Budget progress</h3><div class="card-sub">Current period</div></div><a href="${ROUTES.budgets}" class="btn btn-sm">Manage</a></div>
          ${budgets.length ? `<div class="stack" style="gap:15px">${budgets.map(b => {
            const p = Number(b.limit) > 0 ? b.spent / Number(b.limit) * 100 : 0;
            return `<div><div class="budget-meta"><span>${esc(b.category)} · ${esc(b.period)}</span><span class="${p >= 100 ? 'over-budget' : ''}">${esc(fmt(b.spent, 0))} / ${esc(fmt(b.limit, 0))}</span></div>
              <div class="progress ${p >= 100 ? 'over' : ''}"><span style="width:${Math.min(p, 100).toFixed(1)}%"></span></div></div>`;
          }).join('')}</div>` : emptyState('◈', 'No budgets yet', 'Set a category limit and track it here.')}
        </div>
        <div class="card"><div class="card-head"><div><h3>Retirement snapshot</h3><div class="card-sub">Manually entered accounts</div></div>
          <a class="btn btn-sm" href="${ROUTES.retirement}">Manage</a></div>
          <div class="kv-list">
            <div class="kv"><span>Total balance</span><b>${esc(fmt(retirement.balance))}</b></div>
            <div class="kv"><span>Employee YTD</span><b>${esc(fmt(retirement.employeeYTD))}</b></div>
            <div class="kv"><span>Employer YTD</span><b>${esc(fmt(retirement.employerYTD))}</b></div>
            <div class="kv"><span>Active accounts</span><b>${retirement.activeCount}</b></div>
          </div>
          <div class="data-note">401(k), IRA and HSA records are entered by hand — no employer or custodian login.</div>
        </div>
        ${meridian ? `<div class="card meridian-card">
          <div class="card-head"><div><h3>Meridian snapshot</h3><div class="card-sub">Imported via Connector</div></div><span class="badge live">Linked</span></div>
          <div class="kv-list">
            <div class="kv"><span>Holdings</span><b>${meridian.holdings.length}</b></div>
            <div class="kv"><span>Watchlist</span><b>${meridian.watchlist.length}</b></div>
            <div class="kv"><span>Goals</span><b>${meridian.goals.length}</b></div>
          </div>
          <div class="data-note">${meridian.updatedAt ? `Snapshot saved ${esc(dateLabel(meridian.updatedAt, { relative: true }))}` : 'Snapshot imported'}</div>
          <div style="margin-top:14px"><a class="btn btn-sm" href="${ROUTES.connector}">Open Connector →</a></div>
        </div>` : `<div class="card"><div class="card-head"><h3>Meridian Connector</h3></div>
          <p class="muted small">Already use Meridian? Link a snapshot of your holdings and goals with a six-digit code.</p>
          <div style="margin-top:16px"><a class="btn btn-sm" href="${ROUTES.connector}">Connect Meridian →</a></div></div>`}
      </div>
    </div>`;
}

/* ------------------------------- accounts ------------------------------- */

function accountsView(d) {
  const active = d.accounts.filter(a => !a.archived);
  const totals = ACCOUNT_TYPES.map(type => ({
    type, value: active.filter(a => a.type === type).reduce((s, a) => s + (Number(a.balance) || 0), 0),
    count: active.filter(a => a.type === type).length,
  })).filter(x => x.count);

  return `${pageHead('Accounts', 'Manual records only — no bank login or aggregation.', `<button class="btn btn-primary" data-action="add-account">＋ Add account</button>`)}
    <div class="manual-note" style="margin-bottom:18px"><span class="ic">⚠</span><span><b>Bank login is not enabled.</b> Airo does not store bank credentials or connect to financial institutions. Add each account yourself with the balance you see, and update it when it changes.</span></div>
    ${totals.length ? `<div class="grid grid-4" style="margin-bottom:18px">${totals.map(t => `<div class="card stat-card"><div class="stat-label">${esc(t.type)}</div><div class="stat-value" style="font-size:22px">${esc(fmt(t.value))}</div><div class="stat-foot">${t.count} account${t.count === 1 ? '' : 's'}</div></div>`).join('')}</div>` : ''}
    <div class="grid grid-3">
      ${active.length ? active.map(a => `<div class="card account-card">
        <span class="account-stripe" style="background:${esc(safeColor(a.color))}"></span>
        <div class="account-top"><span class="account-icon" style="background:${esc(safeColor(a.color))}">${esc((a.name || '?')[0].toUpperCase())}</span>
          <div><h3>${esc(a.name)}</h3><p>${esc(a.institution || 'Manual entry')}${a.mask ? ` · ••${esc(a.mask)}` : ''}</p></div></div>
        <div><div class="stat-label">Current balance</div><div class="account-balance">${esc(fmt(a.balance))}</div></div>
        <div class="account-actions"><span class="tag-pill">${esc(a.type || 'Other')}</span>
          <button class="btn btn-sm" data-action="edit-account" data-id="${esc(a.id)}">Edit</button>
          <button class="btn btn-sm" data-action="archive-account" data-id="${esc(a.id)}" title="Hide from balances">Archive</button>
          <button class="btn btn-sm btn-danger" data-action="delete-account-row" data-id="${esc(a.id)}">✕</button></div>
      </div>`).join('') : `<div style="grid-column:1/-1">${emptyState('▤', 'No accounts yet', 'Add a checking account, savings account, card or cash balance to get started.', `<button class="btn btn-primary" data-action="add-account">Add your first account</button>`)}</div>`}
    </div>
    ${d.accounts.some(a => a.archived) ? `<div class="card" style="margin-top:18px"><div class="card-head"><h3>Archived accounts</h3><span class="tag-pill">${d.accounts.filter(a => a.archived).length}</span></div>
      <div class="kv-list">${d.accounts.filter(a => a.archived).map(a => `<div class="kv"><span>${esc(a.name)} · ${esc(a.type)}</span><b>${esc(fmt(a.balance))} <button class="btn btn-sm" data-action="unarchive-account" data-id="${esc(a.id)}">Restore</button></b></div>`).join('')}</div></div>` : ''}`;
}

/* ----------------------------- transactions ----------------------------- */

function transactionsView(d) {
  const accounts = d.accounts;
  const rows = filteredTransactions(d);
  const map = runningBalances(d);
  const header = `<div class="field"><label for="tx-search">Search</label><input class="input" id="tx-search" placeholder="Description, category, date…" value="${esc(state.txFilter.search)}"/></div>`;
  return `${pageHead('Transactions', 'Record income, expenses and transfers.', `<button class="btn btn-primary" data-action="add-transaction">＋ Add transaction</button>`)}
    <div class="card" style="margin-bottom:18px">
      <div class="filter-bar">
        ${header}
        <div class="field"><label for="tx-account">Account</label><select class="input" id="tx-account"><option value="all">All accounts</option>${accounts.map(a => `<option value="${esc(a.id)}" ${selected(a.id, state.txFilter.account)}>${esc(a.name)}</option>`).join('')}</select></div>
        <div class="field"><label for="tx-category">Category</label><select class="input" id="tx-category"><option value="all">All categories</option>${CATEGORIES.map(c => `<option value="${esc(c)}" ${selected(c, state.txFilter.category)}>${esc(c)}</option>`).join('')}</select></div>
        <div class="field"><label for="tx-type">Type</label><select class="input" id="tx-type"><option value="all">All types</option>${TRANSACTION_TYPES.map(t => `<option value="${esc(t)}" ${selected(t, state.txFilter.type)}>${esc(t)}</option>`).join('')}</select></div>
      </div>
    </div>
    <div class="card">
      <div class="card-head"><div><h3>All transactions</h3><div class="card-sub" id="tx-count">${rows.length} record${rows.length === 1 ? '' : 's'}</div></div>
        <div class="data-note">Running balance is estimated from each account’s current balance.</div></div>
      ${rows.length ? `<div class="table-scroll"><table class="data"><thead><tr><th>Transaction</th><th>Category</th><th>Type</th><th>Account</th><th>Amount</th><th>Running balance</th><th>Actions</th></tr></thead>
        <tbody id="tx-tbody">${recentRows(rows, d, map, true)}</tbody></table></div>`
        : `<div id="tx-tbody">${emptyState('↔', 'No matching transactions', 'Try a different filter, or record a new transaction.', `<button class="btn btn-primary btn-sm" data-action="add-transaction">Add transaction</button>`)}</div>`}
    </div>`;
}

function renderTxRows() {
  const tbody = $('#tx-tbody');
  if (!tbody) return;
  const d = store.data();
  const rows = filteredTransactions(d);
  const map = runningBalances(d);
  tbody.innerHTML = rows.length ? recentRows(rows, d, map, true)
    : `<tr><td colspan="7">${emptyState('↔', 'No matching transactions', 'Try a different filter, or record a new transaction.')}</td></tr>`;
  const count = $('#tx-count');
  if (count) count.textContent = `${rows.length} record${rows.length === 1 ? '' : 's'}`;
}

/* -------------------------------- budgets -------------------------------- */

function budgetsView(d) {
  const rows = d.budgets.map(b => ({ ...b, spent: budgetSpent(b, d) }));
  const chartItems = rows.slice(0, 6).map(b => ({
    label: b.category, value: Math.max(b.spent, 0),
    color: b.spent > Number(b.limit) ? '#fb7185' : colorFor(b.category),
    display: fmt(b.spent, 0),
  }));
  return `${pageHead('Budgets', 'Give every category a limit and watch the progress.', `<button class="btn btn-primary" data-action="add-budget">＋ New budget</button>`)}
    <div class="grid grid-main">
      <div class="grid grid-2" style="align-content:start">
        ${rows.length ? rows.map(b => {
          const limit = Number(b.limit) || 0;
          const p = limit > 0 ? b.spent / limit * 100 : 0;
          return `<div class="card"><div class="budget-top"><div><h3>${esc(b.category)}</h3><div class="card-sub">${esc(b.period)} limit</div></div>
            <div class="row-actions"><button class="btn btn-sm" data-action="edit-budget" data-id="${esc(b.id)}">Edit</button>
              <button class="btn btn-sm btn-danger" data-action="delete-budget" data-id="${esc(b.id)}">✕</button></div></div>
            <div style="margin-top:18px"><div class="budget-meta"><span>${p >= 100 ? `<span class="over-budget">${(p - 100).toFixed(0)}% over</span>` : `${Math.max(0, 100 - p).toFixed(0)}% left`}</span>
              <span>${esc(fmt(b.spent, 0))} / ${esc(fmt(limit, 0))}</span></div>
              <div class="progress ${p >= 100 ? 'over' : ''}"><span style="width:${Math.min(p, 100).toFixed(1)}%"></span></div></div>
          </div>`;
        }).join('') : `<div style="grid-column:1/-1">${emptyState('◈', 'No budgets yet', 'Create a monthly or weekly limit for a spending category.', `<button class="btn btn-primary" data-action="add-budget">Create a budget</button>`)}</div>`}
      </div>
      <div class="stack">
        <div class="card"><div class="card-head"><h3>Spending by budget</h3></div>${bars(chartItems)}</div>
        <div class="notice">Budgets are calculated from expense transactions in the current month (or the last 7 days for weekly budgets). Transfers and income never count as spending.</div>
      </div>
    </div>`;
}

/* ------------------------------- recurring ------------------------------- */

function recurringView(d) {
  const rows = [...d.recurring].sort((a, b) => String(a.nextDate || '').localeCompare(String(b.nextDate || '')));
  const annual = rows.reduce((s, r) => s + recurringInfo(r).annual, 0);
  const monthly = annual / 12;
  const soon = rows.filter(r => {
    const days = (Date.parse(r.nextDate) - Date.now()) / 86400000;
    return days >= 0 && days <= 7;
  }).length;
  return `${pageHead('Recurring', 'Upcoming bills and subscriptions, with a clear annual cost.', `<button class="btn btn-primary" data-action="add-recurring">＋ Add recurring</button>`)}
    <div class="grid grid-3" style="margin-bottom:18px">
      <div class="card stat-card"><div class="stat-label">Monthly equivalent</div><div class="stat-value" style="font-size:24px">${esc(fmt(monthly))}</div></div>
      <div class="card stat-card"><div class="stat-label">Annualized cost</div><div class="stat-value" style="font-size:24px">${esc(fmt(annual))}</div></div>
      <div class="card stat-card"><div class="stat-label">Due within 7 days</div><div class="stat-value" style="font-size:24px">${soon}</div></div>
    </div>
    <div class="card">
      <div class="card-head"><div><h3>Schedule</h3><div class="card-sub">Sorted by next date</div></div></div>
      ${rows.length ? `<div class="table-scroll"><table class="data"><thead><tr><th>Item</th><th>Category</th><th>Account</th><th>Next date</th><th>Amount</th><th>Annualized</th><th>Actions</th></tr></thead><tbody>
        ${rows.map(r => {
          const acc = d.accounts.find(a => a.id === r.accountId);
          const days = Math.ceil((Date.parse(r.nextDate) - Date.now()) / 86400000);
          return `<tr><td><div class="sym-cell"><span class="sym-logo" style="background:${esc(colorFor(r.name || 'R'))}">${esc((r.name || '?')[0].toUpperCase())}</span><span><strong>${esc(r.name)}</strong><small>${esc(r.frequency)}</small></span></div></td>
            <td><span class="tag-pill">${esc(r.category || 'Other')}</span></td>
            <td class="muted">${esc(acc?.name || 'Unassigned')}</td>
            <td>${esc(dateLabel(r.nextDate, { short: true }))}${days >= 0 && days <= 7 ? ' <span class="badge warn">Soon</span>' : ''}</td>
            <td>${esc(fmt(r.amount))}</td><td>${esc(fmt(recurringInfo(r).annual, 0))}</td>
            <td><div class="row-actions"><button class="btn btn-sm" data-action="advance-recurring" data-id="${esc(r.id)}" title="Move to next occurrence">Next</button>
              <button class="btn btn-sm" data-action="edit-recurring" data-id="${esc(r.id)}">Edit</button>
              <button class="btn btn-sm btn-danger" data-action="delete-recurring" data-id="${esc(r.id)}">✕</button></div></td></tr>`;
        }).join('')}
      </tbody></table></div>` : emptyState('⟳', 'Nothing recurring yet', 'Add rent, subscriptions or any bill that comes back around.', `<button class="btn btn-primary" data-action="add-recurring">Add recurring item</button>`)}
    </div>`;
}

/* --------------------------------- goals --------------------------------- */

function goalsView(d) {
  return `${pageHead('Goals', 'Save toward something specific and watch the distance close.', `<button class="btn btn-primary" data-action="add-goal">＋ New goal</button>`)}
    <div class="grid grid-3">
      ${d.goals.length ? d.goals.map(g => {
        const target = Number(g.target) || 0;
        const current = Number(g.current) || 0;
        const p = target > 0 ? current / target * 100 : 0;
        return `<div class="card goal-card">
          <div class="goal-top"><span class="goal-icon" style="background:${esc(colorFor(g.name || 'G'))}22">◎</span>
            <div style="flex:1"><h3>${esc(g.name)}</h3><div class="card-sub">${g.deadline ? `Target ${esc(dateLabel(g.deadline, { short: true }))}` : 'No deadline'}</div></div>
            <div class="row-actions"><button class="btn btn-sm btn-ghost" data-action="edit-goal" data-id="${esc(g.id)}">✎</button>
              <button class="btn btn-sm btn-ghost" data-action="delete-goal" data-id="${esc(g.id)}">✕</button></div></div>
          <div><div class="budget-meta"><span>${esc(fmt(current, 0))} saved</span><span>${esc(fmt(target, 0))} target</span></div>
            <div class="progress"><span style="width:${Math.min(p, 100).toFixed(1)}%"></span></div></div>
          <div class="budget-meta"><span>${p.toFixed(0)}% complete</span><span>${esc(fmt(Math.max(target - current, 0), 0))} to go</span></div>
          <button class="btn btn-sm" data-action="contribute-goal" data-id="${esc(g.id)}">＋ Add contribution</button>
        </div>`;
      }).join('') : `<div style="grid-column:1/-1">${emptyState('◎', 'No goals yet', 'Pick a target amount and start tracking progress.', `<button class="btn btn-primary" data-action="add-goal">Create a goal</button>`)}</div>`}
    </div>`;
}

/* ------------------------------ retirement ------------------------------ */

function retirementRows(rows) {
  if (!rows.length) {
    return `<tr><td colspan="9">${emptyState('◴', 'No matching accounts', 'Add a retirement account or change the filters above.', `<button class="btn btn-primary btn-sm" data-action="add-retirement">Add retirement account</button>`)}</td></tr>`;
  }
  return rows.map(a => {
    const vested = Number(a.vestedPercent) || 0;
    const updated = a.updatedAt ? dateLabel(a.updatedAt, { short: true }) : '—';
    return `<tr>
      <td><div class="sym-cell"><span class="sym-logo" style="background:${esc(colorFor(retirementLabel(a.type)))}">${esc((a.name || '?')[0].toUpperCase())}</span>
        <span><strong>${esc(a.name || 'Unnamed account')}</strong><small>${esc(a.owner || 'No owner recorded')}${a.accountLast4 ? ` · ••${esc(a.accountLast4)}` : ''}</small></span></div></td>
      <td><span class="tag-pill">${esc(retirementLabel(a.type))}</span></td>
      <td class="muted">${esc(a.institution || 'Manual entry')}</td>
      <td>${esc(fmt(a.balance))}</td>
      <td>${esc(fmt(a.employeeYTD))}</td>
      <td>${esc(fmt(a.employerYTD))}</td>
      <td>${vested.toFixed(1)}%</td>
      <td><span class="badge ${a.status === 'active' ? 'up' : 'neutral'}">${esc(retirementStatusLabel(a.status))}</span><small class="muted" style="display:block;margin-top:4px">${esc(updated)}</small></td>
      <td><div class="row-actions">
        <button class="btn btn-sm" data-action="edit-retirement" data-id="${esc(a.id)}">Edit</button>
        <button class="btn btn-sm btn-danger" data-action="delete-retirement" data-id="${esc(a.id)}">✕</button>
      </div></td>
    </tr>`;
  }).join('');
}

function retirementView(d) {
  const ret = retirementTotals(d);
  const rows = filteredRetirement(d);
  const allocation = retirementAllocation(ret.rows);
  const filterBar = `<div class="field"><label for="ret-type">Type</label><select class="input" id="ret-type">
      <option value="all" ${selected('all', state.retirementFilter.type)}>All types</option>
      ${RETIREMENT_TYPES.map(t => `<option value="${esc(t.value)}" ${selected(t.value, state.retirementFilter.type)}>${esc(t.label)}</option>`).join('')}
    </select></div>
    <div class="field"><label for="ret-status">Status</label><select class="input" id="ret-status">
      <option value="all" ${selected('all', state.retirementFilter.status)}>All statuses</option>
      ${RETIREMENT_STATUSES.map(s => `<option value="${esc(s.value)}" ${selected(s.value, state.retirementFilter.status)}>${esc(s.label)}</option>`).join('')}
    </select></div>`;

  return `${pageHead('Retirement', 'Track 401(k)s, IRAs, HSAs and other accounts you manage yourself.', `<button class="btn btn-primary" data-action="add-retirement">＋ Add account</button>`)}
    <div class="manual-note" style="margin-bottom:18px"><span class="ic">⚠</span><span><b>Retirement data is entered manually.</b> Airo does not connect to employers, payroll providers or custodians. Enter balances and year-to-date contributions exactly as you see them, then update them when they change.</span></div>
    <div class="grid grid-4" style="margin-bottom:18px">
      <div class="card stat-card"><div class="stat-label">Total balance</div><div class="stat-value">${esc(fmt(ret.balance))}</div><div class="stat-foot">${ret.rows.length} account${ret.rows.length === 1 ? '' : 's'} recorded</div></div>
      <div class="card stat-card"><div class="stat-label">Employee YTD</div><div class="stat-value up">${esc(fmt(ret.employeeYTD))}</div><div class="stat-foot">Your contributions</div></div>
      <div class="card stat-card"><div class="stat-label">Employer YTD</div><div class="stat-value up">${esc(fmt(ret.employerYTD))}</div><div class="stat-foot">Match and profit sharing</div></div>
      <div class="card stat-card"><div class="stat-label">Active accounts</div><div class="stat-value">${ret.activeCount}</div><div class="stat-foot">Excludes closed accounts</div></div>
    </div>

    <div class="grid grid-main" style="margin-bottom:18px">
      <div class="card">
        <div class="card-head"><div><h3>Allocation by type</h3><div class="card-sub">Based on recorded balances</div></div></div>
        ${allocation.length
          ? `<div style="display:flex;gap:20px;align-items:center;flex-wrap:wrap">
              ${donut(allocation, { size: 168, label: 'Balance', value: fmt(ret.balance, 0) })}
              <div class="legend" style="flex:1;min-width:140px">${allocation.map(a => `<div class="legend-item"><span class="legend-dot" style="background:${esc(a.color)}"></span><span class="nm">${esc(a.label)}</span><b>${esc(fmt(a.value, 0))}</b></div>`).join('')}</div>
            </div>`
          : emptyState('◔', 'Nothing to chart yet', 'Add a retirement account with a balance to see your mix by type.')}
      </div>
      <div class="card">
        <div class="card-head"><div><h3>Contribution snapshot</h3><div class="card-sub">Year to date, all accounts</div></div></div>
        <div class="kv-list">
          <div class="kv"><span>Employee contributions</span><b>${esc(fmt(ret.employeeYTD))}</b></div>
          <div class="kv"><span>Employer contributions</span><b>${esc(fmt(ret.employerYTD))}</b></div>
          <div class="kv"><span>Combined YTD</span><b>${esc(fmt(ret.employeeYTD + ret.employerYTD))}</b></div>
        </div>
        <div class="notice" style="margin-top:16px">Balances and contributions are local manual records. Nothing here is fetched from a bank, employer or retirement provider.</div>
      </div>
    </div>

    <div class="card" style="margin-bottom:18px">
      <div class="filter-bar" style="grid-template-columns:repeat(2, minmax(120px, 1fr))">${filterBar}</div>
    </div>
    <div class="card">
      <div class="card-head"><div><h3>Retirement accounts</h3><div class="card-sub" id="ret-count">${rows.length} record${rows.length === 1 ? '' : 's'}</div></div>
        <div class="data-note">Vesting and account details are optional manual fields.</div></div>
      ${rows.length
        ? `<div class="table-scroll"><table class="data"><thead><tr><th>Account</th><th>Type</th><th>Institution</th><th>Balance</th><th>Employee YTD</th><th>Employer YTD</th><th>Vested</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody id="ret-tbody">${retirementRows(rows)}</tbody></table></div>`
        : `<div id="ret-tbody">${retirementRows(rows)}</div>`}
    </div>`;
}

function renderRetirementRows() {
  const tbody = $('#ret-tbody');
  if (!tbody) return;
  const rows = filteredRetirement(store.data());
  tbody.innerHTML = rows.length ? retirementRows(rows)
    : `<tr><td colspan="9">${emptyState('◴', 'No matching accounts', 'Try a different filter, or add a retirement account.')}</td></tr>`;
  const count = $('#ret-count');
  if (count) count.textContent = `${rows.length} record${rows.length === 1 ? '' : 's'}`;
}

/* -------------------------------- insights -------------------------------- */

function insightsView(d) {
  const ins = insightsFor(d);
  const spendItems = ins.m.spend.slice(0, 6).map((s, i) => ({ ...s, display: fmt(s.value, 0) }));
  const budgetItems = ins.budgets.slice(0, 6).map(b => ({
    label: b.category, value: b.spent,
    color: b.spent > Number(b.limit) ? '#fb7185' : colorFor(b.category),
    display: fmt(b.spent, 0),
  }));
  return `${pageHead('Insights', 'Straight answers from the numbers you already recorded.')}
    <div class="grid grid-4" style="margin-bottom:18px">
      <div class="card"><div class="insight"><span class="ic">◈</span><div><strong>Top spending category</strong>
        <p>${ins.top ? `${esc(ins.top.label)} · ${esc(fmt(ins.top.value, 0))} this month` : 'Add expenses to discover your biggest category.'}</p></div></div></div>
      <div class="card"><div class="insight"><span class="ic">↗</span><div><strong>Savings rate</strong>
        <p>${ins.m.income ? `${ins.m.savingsRate.toFixed(1)}% of income kept this month.` : 'Record income to calculate a savings rate.'}</p></div></div></div>
      <div class="card"><div class="insight"><span class="ic">⟳</span><div><strong>Largest recurring cost</strong>
        <p>${ins.largest ? `${esc(ins.largest.name)} · ${esc(fmt(recurringInfo(ins.largest).annual, 0))}/year` : 'No recurring items recorded yet.'}</p></div></div></div>
      <div class="card"><div class="insight"><span class="ic">✓</span><div><strong>Budget health</strong>
        <p>${ins.budgets.length ? `${ins.healthy} of ${ins.budgets.length} within limit.` : 'Create a budget to see your health at a glance.'}</p></div></div></div>
    </div>
    <div class="grid grid-3" style="margin-bottom:18px">
      <div class="card"><div class="insight"><span class="ic">◴</span><div><strong>Largest retirement account</strong>
        <p>${ins.largestRetirement ? `${esc(ins.largestRetirement.name)} · ${esc(fmt(ins.largestRetirement.balance, 0))}` : 'Add a retirement account to identify the largest balance.'}</p></div></div></div>
      <div class="card"><div class="insight"><span class="ic">↗</span><div><strong>Employer match YTD</strong>
        <p>${esc(fmt(ins.retirement.employerYTD, 0))} across ${ins.retirement.rows.length} manually recorded account${ins.retirement.rows.length === 1 ? '' : 's'}.</p></div></div></div>
      <div class="card"><div class="insight"><span class="ic">⚠</span><div><strong>Manual-entry note</strong>
        <p>Retirement balances are entered by hand. Airo does not sync with employers, payroll systems or account custodians.</p></div></div></div>
    </div>
    <div class="grid grid-2">
      <div class="card"><div class="card-head"><div><h3>Where money went</h3><div class="card-sub">Current month, by category</div></div></div>${bars(spendItems)}</div>
      <div class="card"><div class="card-head"><div><h3>Budget usage</h3><div class="card-sub">Spent against your limits</div></div></div>${bars(budgetItems)}</div>
    </div>
    <div class="notice" style="margin-top:18px">Insights are deterministic calculations over your local data. There is no AI provider, no model download and no external analysis of your transactions. Annual recurring costs assume the selected frequency continues unchanged.</div>`;
}

/* ------------------------------- connector ------------------------------- */

function connectorView(d) {
  const m = meridianParts(d);
  const code = state.connectorCode;
  const info = statusInfo();
  const endpoint = store.getSyncEndpoint();
  return `${pageHead('Meridian Connector', 'Bring a Meridian snapshot into Airo with a one-time code.')}
    <div class="grid grid-main">
      <div class="stack">
        <div class="card meridian-card">
          <div class="card-head"><div><h3>Link Meridian</h3><div class="card-sub">Six-digit codes expire after 10 minutes</div></div>
            <span class="badge ${d.settings.linkedMeridian ? 'live' : 'neutral'}">${d.settings.linkedMeridian ? 'Linked' : 'Not linked'}</span></div>
          <form id="connector-form">
            <div class="field"><label for="connector-endpoint">Sync endpoint</label>
              <input class="input" id="connector-endpoint" name="endpoint" value="${esc(endpoint)}" placeholder="${esc('https://atlas-sync.greenhenry441.workers.dev')}"/></div>
            <div class="field"><label for="connector-code">Meridian code</label>
              <input class="input" id="connector-code" name="code" inputmode="numeric" maxlength="6" placeholder="123456" autocomplete="one-time-code" required/></div>
            <div class="form-error" id="connector-error"></div>
            <div class="btn-row"><button class="btn btn-primary" type="submit">Link Meridian →</button>
              <button class="btn" type="button" data-action="connector-generate-code" title="Requires cloud sign-in">Create link code</button>
              ${d.settings.linkedMeridian ? `<button class="btn btn-danger" type="button" data-action="connector-unlink">Unlink</button>` : ''}</div>
          </form>
          ${code ? `<div style="margin-top:18px"><div class="stat-label" style="margin-bottom:8px">Your link code ${code.expiresAt ? `· expires ${esc(dateLabel(code.expiresAt, { short: true }))}` : ''}</div>
            <div class="code-box">${esc(code.code)}</div>
            <p class="data-note">Paste this code into Meridian’s connector screen to share a snapshot with Airo.</p></div>` : ''}
        </div>
        <div class="card">
          <div class="card-head"><div><h3>Imported snapshot</h3><div class="card-sub">${m.updatedAt ? `Updated ${esc(dateLabel(m.updatedAt, { relative: true }))}` : 'Only stored after a successful link'}</div></div></div>
          ${d.settings.linkedMeridian ? `<div class="grid grid-3">
            <div class="stat-card"><div class="stat-label">Holdings</div><div class="stat-value" style="font-size:24px">${m.holdings.length}</div></div>
            <div class="stat-card"><div class="stat-label">Watchlist</div><div class="stat-value" style="font-size:24px">${m.watchlist.length}</div></div>
            <div class="stat-card"><div class="stat-label">Goals</div><div class="stat-value" style="font-size:24px">${m.goals.length}</div></div>
          </div>
          <div class="grid grid-3" style="margin-top:18px">
            <div><div class="stat-label" style="margin-bottom:8px">Holdings</div>${m.holdings.length ? `<div class="kv-list">${m.holdings.slice(0, 5).map(h => `<div class="kv"><span>${esc(h.symbol || h.name || 'Holding')}</span><b>${esc(h.name || '')}</b></div>`).join('')}</div>` : '<p class="muted small">No holdings in snapshot.</p>'}</div>
            <div><div class="stat-label" style="margin-bottom:8px">Watchlist</div>${m.watchlist.length ? `<div class="kv-list">${m.watchlist.slice(0, 5).map(w => `<div class="kv"><span>${esc(typeof w === 'string' ? w : w.symbol || w.name || 'Item')}</span></div>`).join('')}</div>` : '<p class="muted small">Empty watchlist.</p>'}</div>
            <div><div class="stat-label" style="margin-bottom:8px">Goals</div>${m.goals.length ? `<div class="kv-list">${m.goals.slice(0, 5).map(g => `<div class="kv"><span>${esc(g.name || 'Goal')}</span><b>${esc(fmt(g.target || g.targetValue || 0, 0))}</b></div>`).join('')}</div>` : '<p class="muted small">No goals in snapshot.</p>'}</div>
          </div>` : emptyState('◇', 'No snapshot linked', 'Redeem a Meridian code above to import holdings, watchlist and goals.')}
        </div>
      </div>
      <div class="stack">
        <div class="card"><div class="card-head"><h3>Sync status</h3><span class="badge ${info.cls === 'live' ? 'live' : info.cls === 'offline' ? 'warn' : 'neutral'}" data-sync-badge>${esc(info.badge)}</span></div>
          <div class="sync-grid">
            <div class="sync-row"><span>Live cloud sync</span><b data-sync-status>${esc(info.text)}</b></div>
            <div class="sync-row"><span>Last sync</span><b data-sync-time>${state.cloud.lastSync ? esc(dateLabel(state.cloud.lastSync, { relative: true })) : 'Not synced yet'}</b></div>
            <div class="sync-row"><span>Endpoint</span><b class="truncate">${esc(endpoint)}</b></div>
            <div class="sync-row"><span>Auth mode</span><b>${store.authMode() === 'cloud' ? 'Cloud account' : 'Local browser account'}</b></div>
          </div>
          <div class="btn-row" style="margin-top:16px"><button class="btn btn-sm" data-action="retry-cloud">Check connection</button><a class="btn btn-sm" href="${ROUTES.settings}">Settings →</a></div>
        </div>
        <div class="notice">The Connector shares a read-only snapshot. Airo never asks for Meridian passwords, broker credentials or bank logins. Codes are generated by Atlas Sync and expire automatically.</div>
      </div>
    </div>`;
}

/* -------------------------------- settings -------------------------------- */

function settingsView(d) {
  const info = statusInfo();
  return `${pageHead('Settings', 'Preferences, sync, data and account controls.')}
    <div class="grid grid-2">
      <div class="stack">
        <div class="card"><div class="card-head"><h3>Appearance</h3></div>
          <div class="field"><label for="theme-select">Theme</label><select class="input" id="theme-select">
            <option value="light" ${selected('light', d.settings.theme)}>Daylight (light)</option>
            <option value="dark" ${selected('dark', d.settings.theme)}>Nightfall (dark)</option></select></div>
          <div class="field"><label for="currency-select">Currency</label><select class="input" id="currency-select">
            ${CURRENCIES.map(c => `<option value="${esc(c)}" ${selected(c, d.settings.currency)}>${esc(c)}</option>`).join('')}</select></div>
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
          <p class="data-note">Export includes everything in this workspace, including retirement accounts. Import replaces the current data after validation.</p>
        </div>
        <div class="card"><div class="card-head"><h3>Account</h3></div>
          <div class="kv-list"><div class="kv"><span>Name</span><b>${esc(store.currentUser()?.name || '—')}</b></div>
            <div class="kv"><span>Email</span><b>${esc(store.currentUser()?.email || '—')}</b></div>
            <div class="kv"><span>Local credentials</span><b>${store.authMode() === 'local' ? 'Salted PBKDF2' : 'Cloud bearer token'}</b></div></div>
          <div style="margin-top:18px"><button class="btn btn-danger btn-sm" data-action="delete-profile">Delete this account</button></div>
        </div>
        <div class="card"><div class="card-head"><h3>About Airo</h3></div>
          <p class="muted small">${esc(BRAND.dba)} is a registered trade name (DBA) of ${esc(BRAND.legal)}. ${esc(BRAND.tagline)}</p>
          <div class="notice warn" style="margin-top:14px">Accounts are manual records. Real bank login, credential storage and account aggregation are not enabled in this app.</div>
        </div>
      </div>
    </div>`;
}

/* --------------------------------- render --------------------------------- */

const VIEWS = {
  overview: overviewView, accounts: accountsView, transactions: transactionsView,
  budgets: budgetsView, recurring: recurringView, goals: goalsView,
  retirement: retirementView, insights: insightsView, connector: connectorView, settings: settingsView,
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
      <main class="page">${VIEWS[page](d)}</main></div></div>`;
    attachChartHover(root);
  }
  if (preserveScroll) window.scrollTo(0, y);
  paintSyncStatus();
}

/* --------------------------------- modals --------------------------------- */

function colorField(id, value, palette = ACCOUNT_COLORS) {
  const chosen = safeColor(value, palette[0]);
  return `<input type="hidden" id="${esc(id)}" name="color" value="${esc(chosen)}"/>
    <div class="color-swatches">${palette.map(c => `<button type="button" class="swatch ${c.toLowerCase() === chosen.toLowerCase() ? 'active' : ''}"
      data-action="pick-color" data-target="${esc(id)}" data-color="${esc(c)}" style="background:${esc(c)}" aria-label="Choose color"></button>`).join('')}</div>`;
}

function accountModal(id) {
  const a = store.data().accounts.find(x => x.id === id);
  openModal(`${modalHead(a ? 'Edit account' : 'Add a manual account', 'No bank login — you enter the balance yourself.')}
    <form id="account-form"><input type="hidden" name="id" value="${esc(a?.id || '')}"/>
      <div class="form-grid">
        <div class="field"><label for="a-name">Account name</label><input class="input" id="a-name" name="name" value="${esc(a?.name || '')}" placeholder="Everyday checking" required/></div>
        <div class="field"><label for="a-institution">Institution</label><input class="input" id="a-institution" name="institution" value="${esc(a?.institution || '')}" placeholder="Manual entry"/></div>
      </div>
      <div class="form-grid">
        <div class="field"><label for="a-type">Type</label><select class="input" id="a-type" name="type">${ACCOUNT_TYPES.map(t => `<option value="${esc(t)}" ${selected(t, a?.type || 'Checking')}>${esc(t)}</option>`).join('')}</select></div>
        <div class="field"><label for="a-mask">Mask / last digits (optional)</label><input class="input" id="a-mask" name="mask" value="${esc(a?.mask || '')}" placeholder="4242" maxlength="8"/></div>
      </div>
      <div class="field"><label for="a-balance">Current balance</label><input class="input" id="a-balance" name="balance" type="number" step="0.01" value="${esc(a?.balance ?? 0)}" required/></div>
      <div class="field"><label>Accent color</label>${colorField('a-color', a?.color)}</div>
      ${a ? `<label class="checkrow"><input type="checkbox" name="archived" ${a.archived ? 'checked' : ''}/> Archived (hide from totals)</label>` : ''}
      <div class="form-error" id="account-error"></div>
      <div class="modal-actions"><button type="button" class="btn" data-action="modal-close">Cancel</button><button class="btn btn-primary" type="submit">${a ? 'Save changes' : 'Add account'}</button></div>
    </form>`);
}

function transactionModal(id) {
  const d = store.data();
  const t = d.transactions.find(x => x.id === id);
  const accountOptions = d.accounts.map(a => `<option value="${esc(a.id)}" ${selected(a.id, t?.accountId || d.accounts[0]?.id)}>${esc(a.name)}${a.archived ? ' (archived)' : ''}</option>`).join('');
  if (!d.accounts.length) {
    openModal(`${modalHead('Add a transaction', 'You need an account first.')}
      <p class="muted small">Transactions belong to a manual account. Add one, then record your money.</p>
      <div class="modal-actions"><button class="btn" data-action="modal-close">Cancel</button><button class="btn btn-primary" data-action="add-account">Add account</button></div>`);
    return;
  }
  openModal(`${modalHead(t ? 'Edit transaction' : 'Add a transaction', 'Income, expense or transfer — all local records.')}
    <form id="transaction-form"><input type="hidden" name="id" value="${esc(t?.id || '')}"/>
      <div class="field"><label for="t-description">Description</label><input class="input" id="t-description" name="description" value="${esc(t?.description || '')}" placeholder="Weekly groceries" required/></div>
      <div class="form-grid">
        <div class="field"><label for="t-account">Account</label><select class="input" id="t-account" name="accountId">${accountOptions}</select></div>
        <div class="field"><label for="t-date">Date</label><input class="input" id="t-date" name="date" type="date" value="${esc(t?.date || dateInput())}" required/></div>
      </div>
      <div class="form-grid">
        <div class="field"><label for="t-category">Category</label><select class="input" id="t-category" name="category">${CATEGORIES.map(c => `<option value="${esc(c)}" ${selected(c, t?.category || 'Groceries')}>${esc(c)}</option>`).join('')}</select></div>
        <div class="field"><label for="t-type">Type</label><select class="input" id="t-type" name="type">${TRANSACTION_TYPES.map(x => `<option value="${esc(x)}" ${selected(x, t?.type || 'expense')}>${esc(x)}</option>`).join('')}</select></div>
      </div>
      <div class="field"><label for="t-amount">Amount</label><input class="input" id="t-amount" name="amount" type="number" step="0.01" min="0" value="${esc(Math.abs(Number(t?.amount) || 0) || '')}" placeholder="0.00" required/></div>
      <div class="form-error" id="transaction-error"></div>
      <div class="modal-actions"><button type="button" class="btn" data-action="modal-close">Cancel</button><button class="btn btn-primary" type="submit">${t ? 'Save changes' : 'Add transaction'}</button></div>
    </form>`);
}

function budgetModal(id) {
  const b = store.data().budgets.find(x => x.id === id);
  openModal(`${modalHead(b ? 'Edit budget' : 'New budget', 'Set a category and a limit.')}
    <form id="budget-form"><input type="hidden" name="id" value="${esc(b?.id || '')}"/>
      <div class="field"><label for="b-category">Category</label><select class="input" id="b-category" name="category">${CATEGORIES.filter(c => !['Income', 'Transfer'].includes(c)).map(c => `<option value="${esc(c)}" ${selected(c, b?.category || 'Groceries')}>${esc(c)}</option>`).join('')}</select></div>
      <div class="form-grid">
        <div class="field"><label for="b-limit">Limit</label><input class="input" id="b-limit" name="limit" type="number" step="0.01" min="0" value="${esc(b?.limit ?? '')}" placeholder="300.00" required/></div>
        <div class="field"><label for="b-period">Period</label><select class="input" id="b-period" name="period">${BUDGET_PERIODS.map(p => `<option value="${esc(p)}" ${selected(p, b?.period || 'monthly')}>${esc(p)}</option>`).join('')}</select></div>
      </div>
      <div class="form-error" id="budget-error"></div>
      <div class="modal-actions"><button type="button" class="btn" data-action="modal-close">Cancel</button><button class="btn btn-primary" type="submit">${b ? 'Save changes' : 'Create budget'}</button></div>
    </form>`);
}

function recurringModal(id) {
  const d = store.data();
  const r = d.recurring.find(x => x.id === id);
  openModal(`${modalHead(r ? 'Edit recurring item' : 'Add recurring item', 'Bills, rent and subscriptions.')}
    <form id="recurring-form"><input type="hidden" name="id" value="${esc(r?.id || '')}"/>
      <div class="field"><label for="r-name">Name</label><input class="input" id="r-name" name="name" value="${esc(r?.name || '')}" placeholder="Internet bill" required/></div>
      <div class="form-grid">
        <div class="field"><label for="r-amount">Amount</label><input class="input" id="r-amount" name="amount" type="number" step="0.01" min="0" value="${esc(r?.amount ?? '')}" placeholder="49.99" required/></div>
        <div class="field"><label for="r-next">Next date</label><input class="input" id="r-next" name="nextDate" type="date" value="${esc(r?.nextDate || dateInput())}" required/></div>
      </div>
      <div class="form-grid">
        <div class="field"><label for="r-frequency">Frequency</label><select class="input" id="r-frequency" name="frequency">${FREQUENCIES.map(f => `<option value="${esc(f)}" ${selected(f, r?.frequency || 'Monthly')}>${esc(f)}</option>`).join('')}</select></div>
        <div class="field"><label for="r-category">Category</label><select class="input" id="r-category" name="category">${CATEGORIES.map(c => `<option value="${esc(c)}" ${selected(c, r?.category || 'Utilities')}>${esc(c)}</option>`).join('')}</select></div>
      </div>
      <div class="field"><label for="r-account">Account (optional)</label><select class="input" id="r-account" name="accountId"><option value="">Unassigned</option>${d.accounts.map(a => `<option value="${esc(a.id)}" ${selected(a.id, r?.accountId)}>${esc(a.name)}</option>`).join('')}</select></div>
      <div class="form-error" id="recurring-error"></div>
      <div class="modal-actions"><button type="button" class="btn" data-action="modal-close">Cancel</button><button class="btn btn-primary" type="submit">${r ? 'Save changes' : 'Add item'}</button></div>
    </form>`);
}

function goalModal(id) {
  const g = store.data().goals.find(x => x.id === id);
  openModal(`${modalHead(g ? 'Edit goal' : 'New goal', 'Give it a target and a starting point.')}
    <form id="goal-form"><input type="hidden" name="id" value="${esc(g?.id || '')}"/>
      <div class="field"><label for="g-name">Goal name</label><input class="input" id="g-name" name="name" value="${esc(g?.name || '')}" placeholder="Emergency fund" required/></div>
      <div class="form-grid">
        <div class="field"><label for="g-target">Target</label><input class="input" id="g-target" name="target" type="number" step="0.01" min="0" value="${esc(g?.target ?? '')}" placeholder="5000.00" required/></div>
        <div class="field"><label for="g-current">Already saved</label><input class="input" id="g-current" name="current" type="number" step="0.01" min="0" value="${esc(g?.current ?? 0)}"/></div>
      </div>
      <div class="field"><label for="g-deadline">Target date (optional)</label><input class="input" id="g-deadline" name="deadline" type="date" value="${esc(g?.deadline || '')}"/></div>
      <div class="form-error" id="goal-error"></div>
      <div class="modal-actions"><button type="button" class="btn" data-action="modal-close">Cancel</button><button class="btn btn-primary" type="submit">${g ? 'Save changes' : 'Create goal'}</button></div>
    </form>`);
}

function contributionModal(id) {
  const g = store.data().goals.find(x => x.id === id);
  if (!g) return;
  openModal(`${modalHead('Add a contribution', g.name)}
    <form id="contribution-form"><input type="hidden" name="id" value="${esc(g.id)}"/>
      <div class="field"><label for="c-amount">Amount to add</label><input class="input" id="c-amount" name="amount" type="number" step="0.01" min="0" placeholder="100.00" required/></div>
      <div class="form-error" id="contribution-error"></div>
      <div class="modal-actions"><button type="button" class="btn" data-action="modal-close">Cancel</button><button class="btn btn-primary" type="submit">Add to goal</button></div>
    </form>`);
}

function retirementModal(id) {
  const a = store.data().retirementAccounts.find(x => x.id === id);
  openModal(`${modalHead(a ? 'Edit retirement account' : 'Add a retirement account', 'Every field is a manual record — no custodian login.')}
    <form id="retirement-form"><input type="hidden" name="id" value="${esc(a?.id || '')}"/>
      <div class="form-grid">
        <div class="field"><label for="ret-name">Account name</label><input class="input" id="ret-name" name="name" value="${esc(a?.name || '')}" placeholder="Employer 401(k)" required/></div>
        <div class="field"><label for="ret-type-field">Type</label><select class="input" id="ret-type-field" name="type">${RETIREMENT_TYPES.map(t => `<option value="${esc(t.value)}" ${selected(t.value, a?.type || '401k')}>${esc(t.label)}</option>`).join('')}</select></div>
      </div>
      <div class="form-grid">
        <div class="field"><label for="ret-institution">Institution / provider</label><input class="input" id="ret-institution" name="institution" value="${esc(a?.institution || '')}" placeholder="Plan custodian"/></div>
        <div class="field"><label for="ret-owner">Owner</label><input class="input" id="ret-owner" name="owner" value="${esc(a?.owner || '')}" placeholder="Your name"/></div>
      </div>
      <div class="form-grid">
        <div class="field"><label for="ret-last4">Account last 4</label><input class="input" id="ret-last4" name="accountLast4" value="${esc(a?.accountLast4 || '')}" placeholder="1234" maxlength="4" inputmode="numeric"/></div>
        <div class="field"><label for="ret-beneficiary">Beneficiary</label><input class="input" id="ret-beneficiary" name="beneficiary" value="${esc(a?.beneficiary || '')}" placeholder="Optional"/></div>
      </div>
      <div class="form-grid">
        <div class="field"><label for="ret-balance">Current balance</label><input class="input" id="ret-balance" name="balance" type="number" step="0.01" min="0" value="${esc(a?.balance ?? 0)}" required/></div>
        <div class="field"><label for="ret-vested">Vested percent</label><input class="input" id="ret-vested" name="vestedPercent" type="number" step="0.01" min="0" max="100" value="${esc(a?.vestedPercent ?? 100)}"/></div>
      </div>
      <div class="form-grid">
        <div class="field"><label for="ret-employee-ytd">Employee YTD</label><input class="input" id="ret-employee-ytd" name="employeeYTD" type="number" step="0.01" min="0" value="${esc(a?.employeeYTD ?? 0)}"/></div>
        <div class="field"><label for="ret-employer-ytd">Employer YTD</label><input class="input" id="ret-employer-ytd" name="employerYTD" type="number" step="0.01" min="0" value="${esc(a?.employerYTD ?? 0)}"/></div>
      </div>
      <div class="field"><label for="ret-status-field">Status</label><select class="input" id="ret-status-field" name="status">${RETIREMENT_STATUSES.map(s => `<option value="${esc(s.value)}" ${selected(s.value, a?.status || 'active')}>${esc(s.label)}</option>`).join('')}</select></div>
      <div class="field"><label for="ret-notes">Notes</label><textarea class="input" id="ret-notes" name="notes" placeholder="Match formula, vesting dates, or anything you want to remember">${esc(a?.notes || '')}</textarea></div>
      <div class="form-error" id="retirement-error"></div>
      <div class="modal-actions"><button type="button" class="btn" data-action="modal-close">Cancel</button><button class="btn btn-primary" type="submit">${a ? 'Save changes' : 'Add account'}</button></div>
    </form>`);
}

function importModal() {
  openModal(`${modalHead('Import Airo data', 'Paste an export or choose a JSON file.')}
    <form id="import-form">
      <div class="field"><label for="import-file">JSON file</label><input class="input" id="import-file" type="file" accept="application/json,.json"/></div>
      <div class="field"><label for="import-json">Or paste JSON</label><textarea class="input" id="import-json" placeholder='{"app":"Airo Finance","data":{…}}'></textarea></div>
      <div class="form-error" id="import-error"></div>
      <div class="modal-actions"><button type="button" class="btn" data-action="modal-close">Cancel</button><button class="btn btn-primary" type="submit">Import and replace</button></div>
    </form>`);
}

/* --------------------------------- actions --------------------------------- */

function nextDateAfter(dateStr, frequency) {
  const d = dateStr ? new Date(dateStr) : new Date();
  if (Number.isNaN(d.getTime())) return dateInput();
  if (frequency === 'Weekly') d.setDate(d.getDate() + 7);
  else if (frequency === 'Monthly') d.setMonth(d.getMonth() + 1);
  else if (frequency === 'Quarterly') d.setMonth(d.getMonth() + 3);
  else d.setFullYear(d.getFullYear() + 1);
  return dateInput(d);
}

async function linkMeridian(code, endpointValue) {
  const errorEl = $('#connector-error');
  if (!/^\d{6}$/.test(String(code).trim())) {
    if (errorEl) errorEl.textContent = 'Enter the six-digit code from Meridian.';
    return false;
  }
  store.setSyncEndpoint(endpointValue);
  syncEventsForCurrentConfig();
  const redeemed = await api.redeemCode(code);
  if (!redeemed.ok || !redeemed.data?.token) {
    if (errorEl) errorEl.textContent = redeemed.error || 'Could not redeem that code.';
    return false;
  }
  const token = redeemed.data.token;
  store.updateData(d => { d.settings.meridianToken = token; }, { source: 'remote' });
  const snapshot = await api.getSnapshot(MERIDIAN_APP, token);
  if (!snapshot.ok || !snapshot.data?.data) {
    if (errorEl) errorEl.textContent = 'Code redeemed, but the Meridian snapshot is not available yet.';
    return false;
  }
  store.updateData(d => {
    d.meridian = snapshot.data;
    d.settings.linkedMeridian = true;
  }, { source: 'local' });
  toast('Meridian snapshot imported.');
  render({ preserveScroll: true });
  return true;
}

async function generateLinkCode() {
  if (!store.cloudToken()) { toast('Sign in with a cloud account to create link codes.', 'error'); return; }
  const button = $('[data-action="connector-generate-code"]');
  if (button) button.disabled = true;
  const res = await api.requestCode();
  if (button) button.disabled = false;
  if (!res.ok || !res.data?.code) { toast(res.error || 'Could not create a link code.', 'error'); return; }
  state.connectorCode = { code: res.data.code, expiresAt: res.data.expiresAt };
  toast('Link code created — paste it into Meridian.');
  render({ preserveScroll: true });
}

document.addEventListener('click', async e => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;

  if (action === 'modal-backdrop') { if (e.target === el) closeModal(); return; }
  if (action === 'modal-close') { closeModal(); return; }
  if (action === 'toggle-theme') {
    store.setPref('theme', store.getPrefs().theme === 'light' ? 'dark' : 'light');
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
  if (action === 'onboard-type') {
    readOnboardFields(); state.onboarding.starterType = el.dataset.type; onboardingModal(); return;
  }
  if (action === 'pick-color') {
    const target = $(`#${el.dataset.target}`);
    if (target) target.value = el.dataset.color;
    $$(`[data-action="pick-color"][data-target="${el.dataset.target}"]`).forEach(s => s.classList.toggle('active', s === el));
    return;
  }

  if (action === 'add-account') { accountModal(); return; }
  if (action === 'edit-account') { accountModal(el.dataset.id); return; }
  if (action === 'archive-account') {
    store.updateData(d => { d.accounts = d.accounts.map(a => a.id === el.dataset.id ? { ...a, archived: true } : a); });
    toast('Account archived.'); render({ preserveScroll: true }); return;
  }
  if (action === 'unarchive-account') {
    store.updateData(d => { d.accounts = d.accounts.map(a => a.id === el.dataset.id ? { ...a, archived: false } : a); });
    toast('Account restored.'); render({ preserveScroll: true }); return;
  }
  if (action === 'delete-account-row') {
    confirmModal({ title: 'Delete this account?', body: 'The account and its transactions will be removed. This cannot be undone.', action: 'confirm-delete-account-row', id: el.dataset.id });
    return;
  }
  if (action === 'confirm-delete-account-row') {
    store.updateData(d => {
      d.accounts = d.accounts.filter(a => a.id !== el.dataset.id);
      d.transactions = d.transactions.filter(t => t.accountId !== el.dataset.id);
      d.recurring = d.recurring.filter(r => r.accountId !== el.dataset.id);
    });
    closeModal(); toast('Account deleted.'); render({ preserveScroll: true }); return;
  }

  if (action === 'add-transaction') { transactionModal(); return; }
  if (action === 'edit-transaction') { transactionModal(el.dataset.id); return; }
  if (action === 'delete-transaction') {
    confirmModal({ title: 'Delete transaction?', body: 'This record will be removed from your history.', action: 'confirm-delete-transaction', id: el.dataset.id });
    return;
  }
  if (action === 'confirm-delete-transaction') {
    store.updateData(d => { d.transactions = d.transactions.filter(t => t.id !== el.dataset.id); });
    closeModal(); toast('Transaction deleted.'); render({ preserveScroll: true }); return;
  }

  if (action === 'add-budget') { budgetModal(); return; }
  if (action === 'edit-budget') { budgetModal(el.dataset.id); return; }
  if (action === 'delete-budget') {
    confirmModal({ title: 'Delete this budget?', body: 'Only the budget is removed; transactions stay intact.', action: 'confirm-delete-budget', id: el.dataset.id });
    return;
  }
  if (action === 'confirm-delete-budget') {
    store.updateData(d => { d.budgets = d.budgets.filter(b => b.id !== el.dataset.id); });
    closeModal(); toast('Budget deleted.'); render({ preserveScroll: true }); return;
  }

  if (action === 'add-recurring') { recurringModal(); return; }
  if (action === 'edit-recurring') { recurringModal(el.dataset.id); return; }
  if (action === 'advance-recurring') {
    store.updateData(d => {
      d.recurring = d.recurring.map(r => r.id === el.dataset.id
        ? { ...r, nextDate: nextDateAfter(r.nextDate, r.frequency) } : r);
    });
    toast('Moved to the next occurrence.'); render({ preserveScroll: true }); return;
  }
  if (action === 'delete-recurring') {
    confirmModal({ title: 'Delete recurring item?', body: 'Future occurrences will no longer appear in your schedule.', action: 'confirm-delete-recurring', id: el.dataset.id });
    return;
  }
  if (action === 'confirm-delete-recurring') {
    store.updateData(d => { d.recurring = d.recurring.filter(r => r.id !== el.dataset.id); });
    closeModal(); toast('Recurring item deleted.'); render({ preserveScroll: true }); return;
  }

  if (action === 'add-goal') { goalModal(); return; }
  if (action === 'edit-goal') { goalModal(el.dataset.id); return; }
  if (action === 'contribute-goal') { contributionModal(el.dataset.id); return; }
  if (action === 'delete-goal') {
    confirmModal({ title: 'Delete this goal?', body: 'Your accounts and transactions are not affected.', action: 'confirm-delete-goal', id: el.dataset.id });
    return;
  }
  if (action === 'confirm-delete-goal') {
    store.updateData(d => { d.goals = d.goals.filter(g => g.id !== el.dataset.id); });
    closeModal(); toast('Goal deleted.'); render({ preserveScroll: true }); return;
  }

  if (action === 'add-retirement') { retirementModal(); return; }
  if (action === 'edit-retirement') { retirementModal(el.dataset.id); return; }
  if (action === 'delete-retirement') {
    confirmModal({ title: 'Delete retirement account?', body: 'This manual record will be removed from your retirement totals. This cannot be undone.', action: 'confirm-delete-retirement', id: el.dataset.id });
    return;
  }
  if (action === 'confirm-delete-retirement') {
    store.updateData(d => { d.retirementAccounts = d.retirementAccounts.filter(a => a.id !== el.dataset.id); });
    closeModal(); toast('Retirement account deleted.'); render({ preserveScroll: true }); return;
  }

  if (action === 'connector-generate-code') { await generateLinkCode(); return; }
  if (action === 'connector-unlink') {
    confirmModal({ title: 'Unlink Meridian?', body: 'The imported snapshot will be removed from Airo. Your Meridian account is unchanged.', action: 'confirm-connector-unlink', id: 'meridian' });
    return;
  }
  if (action === 'confirm-connector-unlink') {
    store.updateData(d => { d.meridian = null; d.settings.linkedMeridian = false; d.settings.meridianToken = ''; });
    closeModal(); toast('Meridian unlinked.'); render({ preserveScroll: true }); return;
  }

  if (action === 'export-data') {
    const blob = new Blob([store.exportData()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `airo-finance-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('Airo data exported.'); return;
  }
  if (action === 'import-data') { importModal(); return; }
  if (action === 'clear-data') {
    confirmModal({ title: 'Clear all app data?', body: 'Accounts, transactions, budgets, recurring items, goals, retirement accounts and the Meridian snapshot will be removed from this workspace.', action: 'confirm-clear-data', id: 'all' });
    return;
  }
  if (action === 'confirm-clear-data') {
    store.clearData(); closeModal(); toast('App data cleared.'); render({ preserveScroll: true }); return;
  }
  if (action === 'cloud-signout') {
    confirmModal({ title: 'Sign out of cloud sync?', body: 'Your local data stays in this browser. Live sync and event updates will stop until you sign in again.', action: 'confirm-cloud-signout', id: 'cloud' });
    return;
  }
  if (action === 'confirm-cloud-signout') {
    stopEvents(); store.signOut();
    state.cloud.status = 'local'; state.syncReady = false; state.connectorCode = null;
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
  // A hidden <input name="id"> shadows the form.id property, so read the attribute instead.
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

  if (formId === 'account-form') {
    const fd = new FormData(form);
    const name = String(fd.get('name') || '').trim();
    const balance = Number(fd.get('balance'));
    if (!name || !Number.isFinite(balance)) { $('#account-error').textContent = 'Give the account a name and a valid balance.'; return; }
    const id = String(fd.get('id') || '');
    store.updateData(d => {
      const payload = {
        name, institution: String(fd.get('institution') || 'Manual entry').trim(),
        type: String(fd.get('type') || 'Other'), mask: String(fd.get('mask') || '').trim(),
        balance, color: safeColor(fd.get('color')), archived: fd.get('archived') === 'on',
      };
      if (id) d.accounts = d.accounts.map(a => a.id === id ? { ...a, ...payload } : a);
      else d.accounts.push({ id: uid('acc'), ...payload });
    });
    closeModal(); toast(id ? 'Account updated.' : 'Account added.'); render({ preserveScroll: true }); return;
  }

  if (formId === 'transaction-form') {
    const fd = new FormData(form);
    const description = String(fd.get('description') || '').trim();
    const amount = Number(fd.get('amount'));
    if (!description || !(amount >= 0)) { $('#transaction-error').textContent = 'Enter a description and a positive amount.'; return; }
    const id = String(fd.get('id') || '');
    const payload = {
      accountId: String(fd.get('accountId') || ''), date: String(fd.get('date') || dateInput()),
      description, category: String(fd.get('category') || 'Other'),
      amount, type: String(fd.get('type') || 'expense'),
    };
    store.updateData(d => {
      if (id) d.transactions = d.transactions.map(t => t.id === id ? { ...t, ...payload } : t);
      else d.transactions.push({ id: uid('tx'), ...payload });
    });
    closeModal(); toast(id ? 'Transaction updated.' : 'Transaction recorded.'); render({ preserveScroll: true }); return;
  }

  if (formId === 'budget-form') {
    const fd = new FormData(form);
    const limit = Number(fd.get('limit'));
    if (!(limit >= 0)) { $('#budget-error').textContent = 'Enter a valid limit.'; return; }
    const id = String(fd.get('id') || '');
    const payload = { category: String(fd.get('category') || 'Other'), limit, period: String(fd.get('period') || 'monthly') };
    store.updateData(d => {
      if (id) d.budgets = d.budgets.map(b => b.id === id ? { ...b, ...payload } : b);
      else d.budgets.push({ id: uid('bud'), ...payload });
    });
    closeModal(); toast(id ? 'Budget updated.' : 'Budget created.'); render({ preserveScroll: true }); return;
  }

  if (formId === 'recurring-form') {
    const fd = new FormData(form);
    const name = String(fd.get('name') || '').trim();
    const amount = Number(fd.get('amount'));
    if (!name || !(amount >= 0)) { $('#recurring-error').textContent = 'Enter a name and a valid amount.'; return; }
    const id = String(fd.get('id') || '');
    const payload = {
      name, amount, nextDate: String(fd.get('nextDate') || dateInput()),
      frequency: String(fd.get('frequency') || 'Monthly'), category: String(fd.get('category') || 'Other'),
      accountId: String(fd.get('accountId') || ''),
    };
    store.updateData(d => {
      if (id) d.recurring = d.recurring.map(r => r.id === id ? { ...r, ...payload } : r);
      else d.recurring.push({ id: uid('rec'), ...payload });
    });
    closeModal(); toast(id ? 'Recurring item updated.' : 'Recurring item added.'); render({ preserveScroll: true }); return;
  }

  if (formId === 'goal-form') {
    const fd = new FormData(form);
    const name = String(fd.get('name') || '').trim();
    const target = Number(fd.get('target'));
    if (!name || !(target > 0)) { $('#goal-error').textContent = 'Give the goal a name and a positive target.'; return; }
    const id = String(fd.get('id') || '');
    const payload = {
      name, target, current: Math.max(0, Number(fd.get('current')) || 0),
      deadline: String(fd.get('deadline') || ''),
    };
    store.updateData(d => {
      if (id) d.goals = d.goals.map(g => g.id === id ? { ...g, ...payload } : g);
      else d.goals.push({ id: uid('goal'), ...payload });
    });
    closeModal(); toast(id ? 'Goal updated.' : 'Goal created.'); render({ preserveScroll: true }); return;
  }

  if (formId === 'contribution-form') {
    const amount = Number(new FormData(form).get('amount'));
    if (!(amount > 0)) { $('#contribution-error').textContent = 'Enter an amount greater than zero.'; return; }
    const id = String(new FormData(form).get('id') || '');
    store.updateData(d => { d.goals = d.goals.map(g => g.id === id ? { ...g, current: (Number(g.current) || 0) + amount } : g); });
    closeModal(); toast('Contribution added.'); render({ preserveScroll: true }); return;
  }

  if (formId === 'retirement-form') {
    const fd = new FormData(form);
    const name = String(fd.get('name') || '').trim();
    const balance = Number(fd.get('balance'));
    const employeeYTD = Number(fd.get('employeeYTD'));
    const employerYTD = Number(fd.get('employerYTD'));
    const vestedPercent = Number(fd.get('vestedPercent'));
    if (!name || !(balance >= 0) || !(employeeYTD >= 0) || !(employerYTD >= 0)
      || !Number.isFinite(vestedPercent) || vestedPercent < 0 || vestedPercent > 100) {
      $('#retirement-error').textContent = 'Enter a name, a balance of zero or more, and a vested percent between 0 and 100.';
      return;
    }
    let type = String(fd.get('type') || 'other');
    if (!RETIREMENT_TYPES.some(t => t.value === type)) type = 'other';
    let status = String(fd.get('status') || 'active');
    if (!RETIREMENT_STATUSES.some(s => s.value === status)) status = 'active';
    const id = String(fd.get('id') || '');
    const payload = {
      name, type, institution: String(fd.get('institution') || '').trim(),
      owner: String(fd.get('owner') || '').trim(),
      accountLast4: String(fd.get('accountLast4') || '').trim().slice(0, 4),
      balance, employeeYTD, employerYTD, vestedPercent,
      beneficiary: String(fd.get('beneficiary') || '').trim(), status,
      notes: String(fd.get('notes') || '').trim(), updatedAt: new Date().toISOString(),
    };
    store.updateData(d => {
      if (id) d.retirementAccounts = d.retirementAccounts.map(a => a.id === id ? { ...a, ...payload } : a);
      else d.retirementAccounts.push({ id: uid('ret'), ...payload });
    });
    closeModal(); toast(id ? 'Retirement account updated.' : 'Retirement account added.'); render({ preserveScroll: true }); return;
  }

  if (formId === 'connector-form') {
    const fd = new FormData(form);
    const button = form.querySelector('button[type="submit"]');
    if (button) button.disabled = true;
    await linkMeridian(String(fd.get('code') || ''), String(fd.get('endpoint') || ''));
    if (button) button.disabled = false;
    return;
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
    if (!result.ok) { $('#import-error').textContent = result.error || 'Import failed.'; return; }
    closeModal(); toast('Airo data imported.'); render({ preserveScroll: false }); return;
  }
});

/* --------------------------- inputs and keys --------------------------- */

document.addEventListener('input', e => {
  if (['tx-search', 'tx-account', 'tx-category', 'tx-type'].includes(e.target.id)) {
    if (e.target.id === 'tx-search') state.txFilter.search = e.target.value;
    renderTxRows();
  }
});

document.addEventListener('change', async e => {
  const el = e.target;
  if (el.id === 'tx-account' || el.id === 'tx-category' || el.id === 'tx-type') {
    state.txFilter[el.id.replace('tx-', '')] = el.value;
    renderTxRows();
  }
  if (el.id === 'ret-type' || el.id === 'ret-status') {
    state.retirementFilter[el.id.replace('ret-', '')] = el.value;
    renderRetirementRows();
  }
  if (el.id === 'theme-select') {
    store.setPref('theme', el.value); applyTheme(); render({ preserveScroll: true });
    const again = $('#theme-select'); if (again) again.focus();
  }
  if (el.id === 'currency-select') {
    store.setPref('currency', el.value); toast(`Display currency set to ${el.value}.`); render({ preserveScroll: true });
    const again = $('#currency-select'); if (again) again.focus();
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
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && route().page === 'transactions') {
    const input = $('#tx-search');
    if (input) { e.preventDefault(); input.focus(); }
  }
});

window.addEventListener('hashchange', () => { closeModal(); render({ preserveScroll: false }); });

/* ---------------------------------- boot ---------------------------------- */

async function boot() {
  applyTheme();
  initCalendarWidget({ app: 'airo', getEndpoint: getSyncEndpoint, getToken: cloudToken });
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
    prepareOnboarding('Finish setup to personalize Airo.');
  }
}

boot();
