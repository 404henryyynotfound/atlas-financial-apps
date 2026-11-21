/* Atlas Business — view layer, routing and interactions.
   Everything renders from local state; no framework, no bundler. */
import {
  BRAND, ROUTES, PAGE_TITLES, CURRENCIES, THEMES, PAY_TYPES, PAY_FREQUENCIES,
  EMPLOYEE_STATUSES, PAYROLL_STATUSES, DEBT_TYPES, DEBT_PRIORITIES, INVOICE_STATUSES,
  EXPENSE_STATUSES, DETAIL_TYPES, SPLIT_METHODS, ACCOUNT_TYPES, TRANSACTION_TYPES,
  BUDGET_PERIODS, CATEGORIES, EXPENSE_CATEGORIES, ACCOUNT_COLORS, CHART_COLORS,
  SYNC_APP, MERIDIAN_APP, RETIREMENT_TYPES, RETIREMENT_PLAN_STATUSES,
  RETIREMENT_ACCOUNT_STATUSES,
} from './config.js';
import * as store from './store.js';
import { getSyncEndpoint, cloudToken } from './store.js';
import * as api from './api.js';
import { lineChart, donut, bars, attachChartHover } from './charts.js';
import { initCalendarWidget } from './calendar-widget.js';
import {
  $, $$, esc, money, num, signClass, round, sum, uid, colorFor, safeColor, dateInput,
  addDays, daysUntil, dateLabel, monthKey, monthLabel, initials, debounce, csvCell,
  downloadText, annualCost, periodGross, payoffProjection, monthsLabel, effectiveAmount,
  settleUp,
} from './utils.js';

const root = $('#app');
const modalHost = $('#modal-host');
const toastHost = $('#toast-host');

const state = {
  authBackend: 'auto',
  lastAuth: null,
  cloud: {
    phase: 'checking', available: false, status: 'local', lastSync: null,
    error: '', bannerDismissed: false,
  },
  onboarding: {
    theme: 'ink', currency: 'USD', companyName: '', starterType: 'employee',
    employeeName: '', accountName: '',
  },
  filters: {
    employees: { search: '', department: 'all', status: 'all' },
    transactions: { search: '', account: 'all', category: 'all', type: 'all' },
    expenses: { search: '', status: 'all' },
    details: { type: 'all' },
  },
  moneyTab: 'accounts',
  connectorBusy: false,
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
  if (location.hash === hash) render();
  else location.hash = hash;
}

function applyTheme() {
  const theme = store.getPrefs().theme === 'paper' ? 'paper' : 'ink';
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'ink' ? '#07111f' : '#f5f4f0');
}

function currency() { return store.getPrefs().currency || 'USD'; }
function fmt(value, digits) { return money(value, currency(), digits != null ? { digits } : undefined); }
function selected(value, current) { return String(value) === String(current) ? 'selected' : ''; }
function active(value, current) { return String(value) === String(current) ? 'active' : ''; }
function options(list, current) {
  return list.map(v => `<option value="${esc(v)}" ${selected(v, current)}>${esc(v)}</option>`).join('');
}

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
function manualNote(text) {
  return `<div class="manual-note"><span class="ic">✎</span><span>${text}</span></div>`;
}
function pageHead(title, subtitle, button = '') {
  return `<div class="page-head"><div><h1>${esc(title)}</h1><p>${esc(subtitle)}</p></div>${button}</div>`;
}
function statusBadge(status) {
  const cls = status === 'paid' || status === 'active' || status === 'approved' ? 'up'
    : status === 'overdue' || status === 'draft' || status === 'inactive' ? 'neutral'
      : status === 'pending' || status === 'onleave' ? 'warn' : 'neutral';
  return `<span class="badge ${cls}">${esc(status)}</span>`;
}
function retirementBadge(status, list) {
  const cls = status === 'active' ? 'up' : status === 'frozen' ? 'warn' : 'neutral';
  return `<span class="badge ${cls}">${esc(retirementStatusLabel(status, list))}</span>`;
}

function daysBadge(date) {
  const days = daysUntil(date);
  if (days == null) return '';
  if (days < 0) return `<span class="date-alert over">${Math.abs(days)}d overdue</span>`;
  if (days <= 14) return `<span class="date-alert">${days === 0 ? 'Due today' : `in ${days}d`}</span>`;
  return '';
}

/* ---------------------------- data analysis ---------------------------- */

function activeEmployees(d) { return d.employees.filter(e => !e.archived && e.status !== 'inactive'); }
function monthlyPayroll(d) { return sum(activeEmployees(d).map(annualCost)) / 12; }
function totalDebt(d) { return sum(d.debts, 'balance'); }
function monthlyDebtService(d) { return sum(d.debts, 'minimumPayment'); }
function cashBalance(d) { return sum(d.accounts.filter(a => !a.archived), 'balance'); }

function meridianParts(d) {
  const raw = d.investments;
  const envelope = raw?.data && typeof raw.data === 'object' ? raw : { data: raw };
  const payload = envelope.data || {};
  const body = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
  return {
    holdings: Array.isArray(body?.holdings) ? body.holdings : [],
    watchlist: Array.isArray(body?.watchlist) ? body.watchlist : [],
    updatedAt: envelope.updatedAt || payload.updatedAt || null,
  };
}

function holdingValue(h) {
  if (Number.isFinite(Number(h?.value)) && Number(h?.value) !== 0) return Math.abs(Number(h.value));
  const qty = Number(h?.quantity ?? h?.shares ?? h?.qty) || 0;
  const price = Number(h?.price ?? h?.last ?? h?.lastPrice ?? h?.marketPrice) || 0;
  return Math.abs(qty * price);
}

function investmentValue(d) {
  if (!d.investments) return 0;
  return sum(meridianParts(d).holdings.map(holdingValue));
}

function netPosition(d) { return cashBalance(d) + investmentValue(d) - totalDebt(d); }

function retirementLabel(type) {
  return RETIREMENT_TYPES.find(t => t.value === type)?.label || 'Other';
}

function retirementStatusLabel(status, list) {
  return list.find(s => s.value === status)?.label || 'Active';
}

function retirementPlanName(d, planId) {
  return d.retirementPlans.find(p => p.id === planId)?.name || 'Unassigned plan';
}

function retirementEmployeeName(d, employeeId) {
  const employee = d.employees.find(e => e.id === employeeId);
  return employee ? (employee.name || 'Unnamed employee') : 'Former employee';
}

function retirementPlanTotals(plan, d) {
  const accounts = d.retirementAccounts.filter(a => a.planId === plan.id);
  return {
    accounts,
    balance: sum(accounts, 'balance'),
    employeeYTD: sum(accounts, 'employeeYTD'),
    employerYTD: sum(accounts, 'employerYTD'),
    participation: accounts.filter(a => a.status === 'active').length,
  };
}

function retirementTotals(d) {
  const plans = Array.isArray(d?.retirementPlans) ? d.retirementPlans : [];
  const accounts = Array.isArray(d?.retirementAccounts) ? d.retirementAccounts : [];
  return {
    plans, accounts,
    balance: sum(accounts, 'balance'),
    employeeYTD: sum(accounts, 'employeeYTD'),
    employerYTD: sum(accounts, 'employerYTD'),
    participation: accounts.filter(a => a.status === 'active').length,
  };
}

function spendByCategory(d, key = monthKey()) {
  const map = {};
  d.transactions.filter(t => t.type === 'expense' && String(t.date || '').slice(0, 7) === key)
    .forEach(t => { const cat = t.category || 'Other'; map[cat] = (map[cat] || 0) + Math.abs(Number(t.amount) || 0); });
  return Object.entries(map).map(([label, value], i) => ({
    label, value, color: CHART_COLORS[i % CHART_COLORS.length],
  })).sort((a, b) => b.value - a.value);
}

function cashflowSeries(d, count = 6) {
  const base = new Date();
  const out = [];
  for (let i = count - 1; i >= 0; i--) {
    const dt = new Date(base.getFullYear(), base.getMonth() - i, 1);
    const key = monthKey(dt);
    const rows = d.transactions.filter(t => String(t.date || '').slice(0, 7) === key);
    const income = sum(rows.filter(t => t.type === 'income').map(t => Math.abs(Number(t.amount) || 0)));
    const expense = sum(rows.filter(t => t.type === 'expense').map(t => Math.abs(Number(t.amount) || 0)));
    out.push({ date: key, label: monthLabel(key), value: round(income - expense) });
  }
  return out;
}

function averageMonthlyExpense(d) {
  const keys = cashflowSeries(d, 3).map(p => p.date);
  const rows = d.transactions.filter(t => t.type === 'expense' && keys.includes(String(t.date || '').slice(0, 7)));
  return sum(rows.map(t => Math.abs(Number(t.amount) || 0))) / keys.length;
}

function runwayMonths(d) {
  const burn = averageMonthlyExpense(d) + monthlyPayroll(d) + monthlyDebtService(d);
  return burn > 0 ? round(cashBalance(d) / burn, 1) : null;
}

function outstandingReceivables(d) {
  return sum(d.invoices.filter(i => i.status !== 'paid'), 'amount');
}

function upcomingDates(d) {
  const out = [];
  d.debts.forEach(item => { if (item.dueDate) out.push({ title: item.name || 'Debt payment', date: item.dueDate, kind: 'Debt', amount: Number(item.minimumPayment) || 0, href: ROUTES.debts }); });
  d.invoices.filter(i => i.status !== 'paid').forEach(item => {
    if (item.dueDate) out.push({ title: item.client || 'Invoice', date: item.dueDate, kind: 'Invoice', amount: Number(item.amount) || 0, href: ROUTES.invoices });
  });
  d.details.filter(x => x.dueDate).forEach(item => {
    out.push({ title: item.title || 'Reminder', date: item.dueDate, kind: 'Record', amount: null, href: ROUTES.details });
  });
  return out.sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

function activityRows(d) {
  const rows = [];
  d.transactions.forEach(x => rows.push({ date: x.date, title: x.description || 'Transaction', kind: 'Money', amount: effectiveAmount(x), href: ROUTES.money }));
  d.payroll.forEach(x => rows.push({ date: x.payDate || x.periodStart, title: `Payroll · ${x.status}`, kind: 'Payroll', amount: -sum(x.items, 'net'), href: ROUTES.payroll }));
  d.debtPayments.forEach(x => rows.push({ date: x.date, title: `Debt payment · ${d.debts.find(y => y.id === x.debtId)?.name || 'Debt'}`, kind: 'Debt', amount: -Number(x.amount || 0), href: ROUTES.debts }));
  d.invoices.forEach(x => rows.push({ date: x.issueDate, title: `Invoice · ${x.client || 'Client'}`, kind: 'Invoice', amount: Number(x.amount) || 0, href: ROUTES.invoices }));
  d.expenses.forEach(x => rows.push({ date: x.date, title: `Expense · ${x.vendor || 'Vendor'}`, kind: 'Expense', amount: -Number(x.amount || 0), href: ROUTES.expenses }));
  d.sharedExpenses.forEach(x => rows.push({ date: x.date, title: `Shared · ${x.title || 'Expense'}`, kind: 'Shared', amount: Number(x.amount) || 0, href: ROUTES.shared }));
  d.retirementPlans.forEach(x => rows.push({ date: x.updatedAt, title: `Retirement plan · ${x.name || 'Plan'}`, kind: 'Retirement', amount: null, href: ROUTES.retirement }));
  d.retirementAccounts.forEach(x => rows.push({ date: x.updatedAt, title: `Retirement account · ${x.name || 'Account'}`, kind: 'Retirement', amount: Number(x.balance) || 0, href: ROUTES.retirement }));
  return rows.filter(r => r.date).sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 8);
}

function groupMembers(group) { return Array.isArray(group?.members) ? group.members : []; }

function groupBalances(group, d) {
  const balances = {};
  groupMembers(group).forEach(m => { balances[m.name] = 0; });
  d.sharedExpenses.filter(x => x.groupId === group.id).forEach(expense => {
    const members = groupMembers(group);
    const payer = members.find(m => m.id === expense.payerId)?.name;
    const total = Math.abs(Number(expense.amount) || 0);
    if (payer && Object.prototype.hasOwnProperty.call(balances, payer)) balances[payer] += total;
    let parts = [];
    if (expense.split === 'custom') {
      parts = members.map(m => ({ name: m.name, amount: Math.abs(Number(expense.custom?.[m.id]) || 0) }));
    } else if (expense.split === 'shares') {
      const totalShares = sum(members.map(m => Number(expense.shares?.[m.id]) || 0));
      parts = members.map(m => ({
        name: m.name,
        amount: totalShares > 0 ? total * ((Number(expense.shares?.[m.id]) || 0) / totalShares) : 0,
      }));
    } else {
      parts = members.map(m => ({ name: m.name, amount: members.length ? total / members.length : 0 }));
    }
    parts.forEach(p => { if (Object.prototype.hasOwnProperty.call(balances, p.name)) balances[p.name] -= p.amount; });
  });
  Object.keys(balances).forEach(k => { balances[k] = round(balances[k]); });
  return balances;
}

function insightsFor(d) {
  const spend = spendByCategory(d);
  const burn = averageMonthlyExpense(d) + monthlyPayroll(d) + monthlyDebtService(d);
  const payrollShare = burn > 0 ? monthlyPayroll(d) / burn * 100 : 0;
  const cashflow = cashflowSeries(d).reduce((s, p) => s + p.value, 0) / 6;
  const debtRatio = cashflow > 0 ? totalDebt(d) / cashflow : (cashBalance(d) > 0 ? totalDebt(d) / cashBalance(d) : 0);
  const receivablesByClient = {};
  d.invoices.filter(i => i.status !== 'paid').forEach(i => {
    const client = i.client || 'Unnamed client';
    receivablesByClient[client] = (receivablesByClient[client] || 0) + (Number(i.amount) || 0);
  });
  const topClient = Object.entries(receivablesByClient).sort((a, b) => b[1] - a[1])[0] || null;
  const busiest = [...d.groups].sort((a, b) =>
    d.sharedExpenses.filter(x => x.groupId === b.id).length - d.sharedExpenses.filter(x => x.groupId === a.id).length)[0] || null;
  const next = upcomingDates(d)[0] || null;
  const vendors = {};
  d.expenses.forEach(e => { const k = e.vendor || 'Unnamed vendor'; vendors[k] = (vendors[k] || 0) + (Number(e.amount) || 0); });
  const topVendor = Object.entries(vendors).sort((a, b) => b[1] - a[1])[0] || null;
  const retirement = retirementTotals(d);
  return { spend, burn, payrollShare, cashflow, debtRatio, topClient, busiest, next, topVendor, retirement };
}

function sortedTransactions(d) {
  return [...d.transactions].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
}

function runningBalances(d) {
  const map = {};
  d.accounts.forEach(a => {
    const rows = d.transactions.filter(t => t.accountId === a.id)
      .sort((x, y) => String(x.date || '').localeCompare(String(y.date || '')));
    let bal = (Number(a.balance) || 0) - sum(rows.map(effectiveAmount));
    rows.forEach(t => { bal += effectiveAmount(t); map[t.id] = bal; });
  });
  return map;
}

function budgetSpent(budget, d = store.data()) {
  const today = dateInput();
  const rows = budget.period === 'weekly'
    ? d.transactions.filter(t => String(t.date) >= dateInput(addDays(new Date(), -6)) && String(t.date) <= today)
    : d.transactions.filter(t => String(t.date || '').slice(0, 7) === monthKey());
  return sum(rows.filter(t => t.type === 'expense' && t.category === budget.category)
    .map(t => Math.abs(Number(t.amount) || 0)));
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

function applyRemoteBody(body) {
  const clean = stripClientId(body);
  const local = store.data().settings;
  clean.settings.cloudToken = local.cloudToken || '';
  clean.settings.meridianToken = local.meridianToken || '';
  store.replaceData(clean, 'remote');
}

async function checkCloud({ silent = false } = {}) {
  const res = await api.health();
  state.cloud.phase = res.ok ? 'online' : 'offline';
  state.cloud.available = !!res.ok;
  state.cloud.error = res.ok ? '' : (res.error || 'Cloud endpoint unavailable.');
  if (!res.ok) state.cloud.status = 'offline';
  else if (store.authMode() === 'cloud' && state.cloud.status !== 'live') state.cloud.status = 'connecting';
  paintSyncStatus();
  if (!silent) render();
  return !!res.ok;
}

async function hydrateCloud() {
  const token = store.cloudToken();
  if (!token || state.cloud.phase !== 'online') return;
  const remote = readRemoteData(await api.getSnapshot(SYNC_APP, token));
  if (!remote?.body) return;
  const meta = store.getSyncMeta();
  const isOwnWrite = remote.body.settings?.syncClientId === store.clientId();
  if (!isOwnWrite && (remote.updatedAt > (meta.remoteAt || 0) || !store.getPrefs().onboardingComplete)) {
    applyRemoteBody(remote.body);
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
  clean.settings.meridianToken = '';
  delete clean.settings.syncClientId;
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
      if (payload.clientId === store.clientId() || remote.body.settings?.syncClientId === store.clientId()) {
        store.setSyncMeta({ remoteAt: at, lastSync: Date.now() });
        state.cloud.lastSync = Date.now();
        paintSyncStatus();
        return;
      }
      if (at && at <= (store.getSyncMeta().remoteAt || 0)) return;
      store.setSyncMeta({ remoteAt: at, lastSync: Date.now() });
      applyRemoteBody(remote.body);
      state.cloud.lastSync = Date.now();
      paintSyncStatus();
      render();
      toast('Latest changes loaded from cloud.');
    } else if (payload.app === MERIDIAN_APP) {
      const token = store.data().settings.meridianToken || store.cloudToken();
      const res = await api.getSnapshot(MERIDIAN_APP, token);
      if (!res.ok || !res.data?.data) return;
      store.updateData(d => {
        d.investments = res.data;
        d.settings.linkedMeridian = true;
      }, { source: 'remote' });
      if (route().page === 'investments' || route().page === 'connections') render();
      toast('Meridian snapshot updated.');
    }
  } catch { /* stream events are best-effort */ }
}

store.subscribe((data, meta) => {
  if (meta.source === 'local' && state.syncReady) schedulePush(data);
  if (store.authMode() === 'cloud') syncEventsForCurrentConfig();
  else if (state.eventSub) stopEvents();
});

/* ------------------------------- landing ------------------------------- */

function brandMarkup(small = false) {
  return `<span class="brand"><span class="brand-mark">A</span><span class="brand-name">${esc(BRAND.product)}${small ? '' : `<span class="brand-sub">a product of ${esc(BRAND.legal)}</span>`}</span></span>`;
}

function landing() {
  const trend = 'M4,130 L44,122 L84,128 L124,102 L164,110 L204,80 L244,88 L284,58 L324,68 L364,40 L404,48 L444,22 L484,30 L520,10';
  const features = [
    ['◫', 'Company overview', 'Net position, cash runway, payroll obligation, receivables, debt and employee count — one clear briefing.'],
    ['♙', 'Employees & payroll', 'People records, salary or hourly pay, pay periods, deductions, approvals and CSV summaries.'],
    ['◇', 'Debts & payoff plans', 'Balances, rates, minimums, recorded payments and deterministic payoff estimates.'],
    ['▤', 'Everyday money', 'Operating, payroll and tax accounts; manual transactions, running balances and budgets.'],
    ['▧', 'Invoices & expenses', 'Receivables by status, overdue highlights, vendor spend and payables.'],
    ['↗', 'Investing view', 'Bring a read-only Meridian snapshot across with a pairing code — no second password.'],
    ['⌁', 'Shared expenses', 'Groups, payer tracking, equal/share/custom splits and simple settle-up suggestions.'],
    ['▦', 'Details / Records', 'Company details, key dates, contacts, and tax or insurance reminders in one list.'],
    ['✦', 'Deterministic insights', 'Local calculations only: cost ratios, cashflow trend, top clients and upcoming dates.'],
  ];
  return `<div class="landing">
    <div class="nav-wrap"><nav class="nav">
      ${brandMarkup()}
      <div class="nav-links"><a href="#product">The workspace</a><a href="#design">Our approach</a><a href="#connect">Connect</a></div>
      <div class="nav-actions">
        <button class="btn btn-icon btn-ghost" data-action="toggle-theme" title="Toggle theme">${store.getPrefs().theme === 'ink' ? '☀' : '◐'}</button>
        <a class="btn btn-ghost btn-sm" href="${ROUTES.signin}">Sign in</a>
        <a class="btn btn-primary btn-sm" href="${ROUTES.signup}">Get started →</a>
      </div>
    </nav></div>

    <header class="hero">
      <div>
        <span class="eyebrow"><span class="pulse-dot"></span> ${esc(BRAND.tagline)}</span>
        <h1>The whole business, <em>in focus.</em></h1>
        <p class="hero-copy">Atlas Business brings the investing view, everyday money and shared expenses together with payroll, employees, debts and business records. One workspace for the numbers that matter — with everything entered by hand.</p>
        <div class="hero-ctas">
          <a class="btn btn-primary btn-lg" href="${ROUTES.signup}">Start your workspace →</a>
          <a class="btn btn-lg" href="${ROUTES.signin}">I already have an account</a>
        </div>
        <div class="hero-note"><span>✓ Manual data only</span><span>✓ No bank logins</span><span>✓ Optional cloud sync</span></div>
      </div>
      <div class="hero-visual">
        <div class="hero-glow"></div>
        <div class="mock-card">
          <div class="mock-top"><span>Company net position</span><span class="tag-pill">All records</span></div>
          <div class="mock-value">$184,260.40</div>
          <div class="mock-change">↗ 6 active employees · 3 accounts</div>
          <div class="mock-chart">
            <svg viewBox="0 0 520 140" preserveAspectRatio="none" aria-hidden="true">
              <defs><linearGradient id="atlasMock" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#2fb8ab" stop-opacity=".32"/><stop offset="100%" stop-color="#2fb8ab" stop-opacity="0"/></linearGradient></defs>
              <path d="${trend} L520,140 L4,140 Z" fill="url(#atlasMock)"/>
              <path d="${trend}" fill="none" stroke="#2fb8ab" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </div>
          <div class="mock-rows">
            <div class="mock-row"><span class="sym"><span class="sym-badge" style="background:#d9ad63">P</span> Monthly payroll</span><b>$28,400</b></div>
            <div class="mock-row"><span class="sym"><span class="sym-badge" style="background:#2fb8ab">R</span> Receivables</span><b>$12,850</b></div>
            <div class="mock-row"><span class="sym"><span class="sym-badge" style="background:#5f8cff">D</span> Debt service</span><b>$1,940 / mo</b></div>
          </div>
        </div>
        <div class="float-chip one"><span class="dot"></span> Payroll ready to approve</div>
        <div class="float-chip two">◈ Meridian snapshot linked</div>
      </div>
    </header>

    <div class="ticker-band"><div class="ticker-track">
      ${[...Array(2)].flatMap(() => ['PAYROLL', 'EMPLOYEES', 'DEBTS', 'ACCOUNTS', 'INVOICES', 'EXPENSES', 'SHARED MONEY', 'RECORDS', 'MERIDIAN'].map(x => `<span class="ticker-item"><b>✦</b>${x}</span>`)).join('')}
    </div></div>

    <section class="section" id="product">
      <div class="section-head"><span class="eyebrow">One flagship workspace</span>
        <h2>Everything the other Atlas apps do — and the rest of the business.</h2>
        <p>Payroll and people sit beside cashflow and debts. Records and reminders sit beside invoices and shared costs. Nothing is hidden behind another login.</p>
      </div>
      <div class="feature-grid">
        ${features.map(([icon, title, copy]) => `<article class="feature"><div class="feature-icon">${icon}</div><h3>${esc(title)}</h3><p>${esc(copy)}</p></article>`).join('')}
      </div>
    </section>

    <section class="section" id="design" style="padding-top:0">
      <div class="split-section">
        <div>
          <span class="eyebrow">Manual by design</span>
          <h2>No bank logins. No payroll provider connections. No guesswork.</h2>
          <p style="color:var(--muted);margin-top:16px">Bank balances, payroll figures and tax reminders are entered by you and labelled as manual data. Atlas Business never asks for bank credentials, payroll provider logins or tax account passwords. Cloud sync is opt-in, and local accounts are protected with salted PBKDF2 hashing in this browser.</p>
          <div class="asset-cloud"><span class="asset-chip"><b>Operating</b></span><span class="asset-chip"><b>Payroll</b></span><span class="asset-chip"><b>Tax</b></span><span class="asset-chip"><b>Invoices</b></span><span class="asset-chip"><b>Debts</b></span><span class="asset-chip"><b>Records</b></span></div>
        </div>
        <div class="card">
          <div class="card-head"><h3>How it works</h3><span class="tag-pill">3 steps</span></div>
          <div class="step-list">
            <div class="step"><b>1</b><div><strong>Create your workspace</strong><p>Use cloud sign-in when Atlas Sync is available, or a private browser account.</p></div></div>
            <div class="step"><b>2</b><div><strong>Add your company details</strong><p>Choose Ink or Paper, your currency, a company name and a starter employee or account.</p></div></div>
            <div class="step"><b>3</b><div><strong>Run the whole picture</strong><p>Payroll, debts, records and money update the overview and insights as you go.</p></div></div>
          </div>
        </div>
      </div>
    </section>

    <section class="section" id="connect" style="padding-top:0">
      <div class="cta-band">
        <span class="eyebrow">Ready when you are</span>
        <h2>The whole business, in focus.</h2>
        <p>Start with your company name and one employee. Everything else can wait.</p>
        <div class="btn-row" style="justify-content:center">
          <a class="btn btn-primary btn-lg" href="${ROUTES.signup}">Create your workspace →</a>
          <a class="btn btn-lg" href="${ROUTES.signin}">Sign in</a>
        </div>
      </div>
    </section>

    <footer class="landing-footer"><div class="footer-inner">
      <div>${brandMarkup()}<p>Atlas Business is a product of Atlas Financial. Manual bank, payroll and tax data only — no bank login, aggregation or provider connections. Informational only; not financial, tax or legal advice.</p></div>
      <div class="footer-links"><a href="#product">Features</a><a href="#design">Our approach</a><a href="#connect">Connect</a><a href="${ROUTES.signin}">Sign in</a><a href="${ROUTES.signup}">Get started</a></div>
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
  return `<div class="auth-page">
    <div class="auth-form-side"><div class="auth-box">
      <a href="${ROUTES.landing}">${brandMarkup()}</a>
      <h1 style="margin-top:28px">${isSignup ? 'Create your workspace' : 'Welcome back'}</h1>
      <p class="sub">${isSignup ? 'A complete business view takes about two minutes.' : 'Sign in to pick up where you left off.'}</p>
      <div class="mode-chip ${available ? '' : 'offline'}">
        <span class="dot"></span>
        <span class="txt"><b>${backend === 'cloud' ? 'Cloud account' : 'Browser account'}</b>
          <span>${backend === 'cloud' ? 'Syncs through Atlas Sync when reachable.' : 'Stored only in this browser with PBKDF2 hashing.'}</span></span>
        <span class="mode-switch">
          <button type="button" class="${backend === 'cloud' ? 'active' : ''}" data-action="set-auth-backend" data-backend="cloud" ${available ? '' : 'disabled title="Cloud endpoint unavailable"'}>Cloud</button>
          <button type="button" class="${backend === 'local' ? 'active' : ''}" data-action="set-auth-backend" data-backend="local">Browser</button>
        </span>
      </div>
      <form id="${isSignup ? 'signup-form' : 'signin-form'}" autocomplete="on">
        ${isSignup ? `<div class="field"><label for="auth-name">Your name</label><input class="input" id="auth-name" name="name" autocomplete="name" placeholder="Alex Morgan" required/></div>` : ''}
        <div class="field"><label for="auth-email">Email address</label><input class="input" id="auth-email" name="email" type="email" autocomplete="email" placeholder="you@company.com" required/></div>
        <div class="field"><label for="auth-password">Password</label><input class="input" id="auth-password" name="password" type="password" autocomplete="${isSignup ? 'new-password' : 'current-password'}" placeholder="At least 8 characters" required/></div>
        <div class="form-error" id="auth-error"></div>
        <button class="btn btn-primary btn-lg" type="submit" style="width:100%">${isSignup ? 'Create account →' : 'Sign in →'}</button>
      </form>
      <div class="auth-switch">${isSignup ? 'Already have an account? ' : 'New to Atlas Business? '}
        <a href="${isSignup ? ROUTES.signin : ROUTES.signup}">${isSignup ? 'Sign in' : 'Create one'}</a></div>
      <p class="data-note">${available ? 'Cloud endpoint reachable.' : `Cloud endpoint unavailable — using local mode. <button type="button" class="btn btn-sm btn-ghost" data-action="retry-cloud">Retry</button>`}</p>
    </div></div>
    <div class="auth-art">
      <span class="eyebrow">${esc(BRAND.dba)}</span>
      <h2>${esc(BRAND.tagline)}</h2>
      <p>People, payroll, debt, cashflow, invoices, shared costs and records — with the investing view brought across from Meridian when you want it.</p>
      <div class="auth-points">
        <div class="auth-point"><span style="color:var(--copper)">✓</span><span>Manual accounts and payroll — nothing connects without you.</span></div>
        <div class="auth-point"><span style="color:var(--copper)">✓</span><span>Debts, details and dates that are easy to keep current.</span></div>
        <div class="auth-point"><span style="color:var(--copper)">✓</span><span>No bank credentials, no OAuth, no payroll provider logins.</span></div>
      </div>
    </div>
  </div>`;
}

function prepareOnboarding(message) {
  state.onboarding = {
    theme: store.getPrefs().theme || 'ink', currency: store.getPrefs().currency || 'USD',
    companyName: store.getPrefs().name || store.data().company.name || '',
    starterType: 'employee', employeeName: '', accountName: '',
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
    if (kind === 'signup' || !store.getPrefs().onboardingComplete) {
      prepareOnboarding(kind === 'signup' ? 'Account created. Let’s personalize Atlas Business.' : 'Welcome back — finish setup to continue.');
      return;
    }
    toast(`Welcome back, ${store.currentUser()?.name || 'there'}.`);
    go(ROUTES.overview);
  } finally {
    if (submit) submit.disabled = false;
  }
}

/* ----------------------------- onboarding ----------------------------- */

function readOnboardFields() {
  const o = state.onboarding;
  const currencyEl = $('#on-currency');
  const companyEl = $('#on-company');
  const employeeEl = $('#on-employee-name');
  const accountEl = $('#on-account-name');
  if (currencyEl) o.currency = currencyEl.value;
  if (companyEl) o.companyName = companyEl.value;
  if (employeeEl) o.employeeName = employeeEl.value;
  if (accountEl) o.accountName = accountEl.value;
}

function onboardingModal() {
  const o = state.onboarding;
  openModal(`<div class="onboarding-head"><span class="eyebrow">First steps</span>
    <h2 style="font-size:26px;margin-top:12px">Make Atlas Business yours</h2>
    <p class="muted small" style="margin-top:6px">Four quick choices. You can change everything later in Settings.</p></div>
    <form id="onboarding-form">
      <div class="onboard-section">
        <div class="onboard-label"><b>1</b><span>Choose a theme</span></div>
        <div class="theme-choices">
          <button type="button" class="theme-choice ${active(o.theme, 'ink')}" data-action="onboard-theme" data-theme="ink">
            <span class="theme-preview ink"><i></i><i></i><i></i></span><span class="theme-icon">◐</span>
            <strong>Ink</strong><small>Deep navy with copper and teal accents.</small></button>
          <button type="button" class="theme-choice ${active(o.theme, 'paper')}" data-action="onboard-theme" data-theme="paper">
            <span class="theme-preview paper"><i></i><i></i><i></i></span><span class="theme-icon">☀</span>
            <strong>Paper</strong><small>Warm, light and easy on the eyes.</small></button>
        </div>
      </div>
      <div class="onboard-section">
        <div class="onboard-label"><b>2</b><span>Base currency</span></div>
        <div class="field"><label for="on-currency">Display currency for all amounts</label>
          <select class="input" id="on-currency">${options(CURRENCIES, o.currency)}</select></div>
      </div>
      <div class="onboard-section">
        <div class="onboard-label"><b>3</b><span>Company name</span></div>
        <div class="field"><label for="on-company">What should we call your business?</label>
          <input class="input" id="on-company" placeholder="Northstar Studio" value="${esc(o.companyName)}"/></div>
      </div>
      <div class="onboard-section">
        <div class="onboard-label"><b>4</b><span>Start with something useful</span></div>
        <div class="starter-choices">
          <button type="button" class="starter-choice ${active(o.starterType, 'employee')}" data-action="onboard-type" data-type="employee"><strong>A starter employee</strong><small>Add someone you pay, with manual pay details.</small></button>
          <button type="button" class="starter-choice ${active(o.starterType, 'account')}" data-action="onboard-type" data-type="account"><strong>A manual account</strong><small>Record an operating or payroll account.</small></button>
        </div>
        ${o.starterType === 'employee'
          ? `<div class="field" style="margin-top:14px"><label for="on-employee-name">Employee name</label><input class="input" id="on-employee-name" placeholder="Jordan Lee" value="${esc(o.employeeName)}"/></div>`
          : `<div class="field" style="margin-top:14px"><label for="on-account-name">Account name</label><input class="input" id="on-account-name" placeholder="Operating checking" value="${esc(o.accountName)}"/></div>`}
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
    d.settings.name = o.companyName.trim() || store.currentUser()?.name || '';
    d.settings.onboardingComplete = true;
    d.company.name = o.companyName.trim();
    if (o.starterType === 'employee' && o.employeeName.trim()) {
      d.employees.push({
        id: uid('emp'), name: o.employeeName.trim(), email: '', role: 'Team member', department: 'Operations',
        payType: 'salary', rate: 0, payFrequency: 'biweekly', startDate: dateInput(),
        status: 'active', archived: false,
      });
    }
    if (o.starterType === 'account' && o.accountName.trim()) {
      d.accounts.push({
        id: uid('acc'), name: o.accountName.trim(), institution: 'Manual entry', type: 'Operating',
        mask: '', balance: 0, color: ACCOUNT_COLORS[0], archived: false,
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
  const current = route().mode === 'app' && route().page === page;
  return `<a class="nav-item ${current ? 'active' : ''}" href="#/app/${page}" title="${esc(label)}"><span class="ico">${icon}</span><span class="label">${esc(label)}</span></a>`;
}

function sidebar() {
  const user = store.currentUser() || {};
  const company = store.data().company.name || BRAND.dba;
  return `<aside class="sidebar">
    ${brandMarkup(true)}
    <div><p class="nav-group-label">Operations</p><nav class="side-nav">
      ${navItem('overview', '◫', 'Overview')}
      ${navItem('employees', '♙', 'Employees')}
      ${navItem('payroll', '▤', 'Payroll')}
      ${navItem('details', '▦', 'Details / Records')}
    </nav></div>
    <div><p class="nav-group-label">Money</p><nav class="side-nav">
      ${navItem('money', '↔', 'Money')}
      ${navItem('invoices', '▧', 'Invoices')}
      ${navItem('expenses', '◈', 'Expenses')}
      ${navItem('debts', '◇', 'Debts')}
      ${navItem('retirement', '◴', 'Retirement')}
    </nav></div>
    <div><p class="nav-group-label">Planning</p><nav class="side-nav">
      ${navItem('shared', '⌁', 'Shared money')}
      ${navItem('investments', '↗', 'Investments')}
      ${navItem('insights', '✦', 'Insights')}
    </nav></div>
    <div><p class="nav-group-label">Connect</p><nav class="side-nav">
      ${navItem('connections', '⚯', 'Connections')}
      ${navItem('settings', '⚙', 'Settings')}
    </nav></div>
    <div class="sidebar-bottom">
      <div class="side-account"><span class="avatar">${esc(initials(user.name || company))}</span>
        <span class="details"><span class="name">${esc(company)}</span><span class="mail">${esc(user.email || BRAND.dba)}</span></span></div>
      <p class="side-note">${esc(BRAND.dba)} · a product of ${esc(BRAND.legal)}. Manual data only.</p>
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
      <button class="btn btn-icon btn-ghost" data-action="toggle-theme" title="Toggle theme">${store.getPrefs().theme === 'ink' ? '☀' : '◐'}</button>
      <button class="btn btn-primary btn-sm" data-action="quick-add">＋ Quick add</button>
    </div>
  </header>`;
}

function bannerMarkup() {
  if (state.cloud.phase !== 'offline' || state.cloud.bannerDismissed) return '';
  return `<div class="banner"><span class="ic">⚠</span>
    <span class="txt"><b>Cloud sync is unavailable.</b> Atlas Business is working in local-only mode — your manual data stays in this browser. ${esc(state.cloud.error || '')}</span>
    <button class="btn btn-sm" data-action="retry-cloud">Retry</button>
    <button class="btn btn-sm btn-ghost" data-action="dismiss-banner">Dismiss</button></div>`;
}

function renderPage(page) {
  const d = store.data();
  const views = {
    overview: overviewView, employees: employeesView, payroll: payrollView, debts: debtsView,
    money: moneyView, invoices: invoicesView, expenses: expensesView, investments: investmentsView,
    shared: sharedView, details: detailsView, retirement: retirementView,
    insights: insightsView, connections: connectionsView, settings: settingsView,
  };
  try { return (views[page] || overviewView)(d); }
  catch { return emptyState('⚠', 'This section could not be rendered', 'Your saved data is safe. Try refreshing the page.'); }
}

function render() {
  const y = window.scrollY;
  const r = route();
  if (r.mode === 'app' && !store.currentUser()) { location.hash = ROUTES.signin; return; }
  if (r.mode === 'landing') root.innerHTML = landing();
  else if (r.mode === 'auth') root.innerHTML = authView(r.kind);
  else root.innerHTML = `<div class="shell">${sidebar()}<main class="main">${topbar(r.page)}${bannerMarkup()}<div class="page">${renderPage(r.page)}</div></main></div>`;
  attachChartHover(root);
  paintSyncStatus();
  const section = r.mode === 'landing' && /^#(product|design|connect)$/.test(location.hash)
    ? document.getElementById(location.hash.slice(1)) : null;
  if (section) section.scrollIntoView({ block: 'start' });
  else window.scrollTo(0, r.mode === 'landing' ? 0 : y);
}

/* ------------------------------- overview ------------------------------- */

function quickActions() {
  const items = [
    ['add-employee', '♙', 'Add employee', 'Person + pay details'],
    ['new-payroll', '▤', 'Run payroll', 'Create a pay period'],
    ['add-debt', '◇', 'Add debt', 'Balance + minimum'],
    ['add-invoice', '▧', 'New invoice', 'Track receivables'],
    ['add-account', '▤', 'Add account', 'Manual balance'],
    ['add-retirement-plan', '◴', 'Add plan', '401(k), IRA or HSA'],
    ['add-retirement-account', '♙', 'Add member account', 'Balance + contributions'],
    ['add-detail', '▦', 'Add record', 'Date or contact'],
  ];
  return `<div class="quick-grid">${items.map(([action, icon, title, sub]) =>
    `<button type="button" class="quick-btn" data-action="${action}"><b>${icon} ${esc(title)}</b><span>${esc(sub)}</span></button>`).join('')}</div>`;
}

function overviewView(d) {
  const m = insightsFor(d);
  const runway = runwayMonths(d);
  const receivables = outstandingReceivables(d);
  const spend = m.spend.slice(0, 6);
  const upcoming = upcomingDates(d).slice(0, 6);
  const activity = activityRows(d);
  const cash = cashBalance(d);
  const investments = investmentValue(d);
  const debt = totalDebt(d);
  const retirement = retirementTotals(d);

  return `${pageHead('Your business at a glance', `${esc(store.data().company.name || BRAND.dba)} · ${esc(dateLabel(new Date(), { short: false }))}`, `<button class="btn btn-primary" data-action="new-payroll">＋ Run payroll</button>`)}
    <div class="grid grid-4" style="margin-bottom:18px">
      <div class="card hero-card"><div class="stat-label">Company net position</div>
        <div class="hero-value">${esc(fmt(netPosition(d)))}</div>
        <div class="hero-meta"><span class="muted small">${esc(fmt(cash))} cash</span>${investments ? `<span class="muted small">${esc(fmt(investments))} investments</span>` : ''}<span class="muted small">−${esc(fmt(debt))} debt</span></div></div>
      <div class="card stat-card"><div class="stat-label">Cash runway</div>
        <div class="stat-value">${runway == null ? '—' : `${esc(num(runway, 1))} mo`}</div>
        <div class="stat-foot">${runway == null ? 'Add cash or expenses to estimate' : `${esc(fmt(m.burn))} estimated monthly outflow`}</div></div>
      <div class="card stat-card"><div class="stat-label">Monthly payroll</div>
        <div class="stat-value">${esc(fmt(monthlyPayroll(d)))}</div>
        <div class="stat-foot">${activeEmployees(d).length} active ${activeEmployees(d).length === 1 ? 'employee' : 'employees'}</div></div>
      <div class="card stat-card"><div class="stat-label">Outstanding receivables</div>
        <div class="stat-value up">${esc(fmt(receivables))}</div>
        <div class="stat-foot">${d.invoices.filter(i => i.status !== 'paid').length} open invoices</div></div>
      <div class="card stat-card"><div class="stat-label">Total debt</div>
        <div class="stat-value down">${esc(fmt(debt))}</div>
        <div class="stat-foot">${esc(fmt(monthlyDebtService(d)))} minimum / month</div></div>
      <div class="card stat-card"><div class="stat-label">Active employees</div>
        <div class="stat-value">${activeEmployees(d).length}</div>
        <div class="stat-foot">${d.employees.filter(e => e.archived).length} archived records</div></div>
    </div>

    <div class="grid grid-main" style="margin-bottom:18px">
      <div class="card">
        <div class="card-head"><div><h3>Cashflow trend</h3><div class="card-sub">Income minus expenses, last 6 months</div></div><span class="tag-pill">Monthly</span></div>
        ${lineChart(cashflowSeries(d).map(p => ({ ...p, date: p.label })), { currency: currency(), height: 220, color: '#2fb8ab', label: 'Monthly cashflow' })}
      </div>
      <div class="card">
        <div class="card-head"><div><h3>Spend by category</h3><div class="card-sub">This month · manual transactions</div></div></div>
        ${spend.length
          ? `<div style="display:flex;gap:20px;align-items:center;flex-wrap:wrap">
              ${donut(spend, { size: 158, label: 'Spent', value: fmt(sum(spend, 'value'), 0) })}
              <div class="legend" style="flex:1;min-width:130px">${spend.map(s => `<div class="legend-item"><span class="legend-dot" style="background:${esc(s.color)}"></span><span class="nm">${esc(s.label)}</span><b>${esc(fmt(s.value, 0))}</b></div>`).join('')}</div>
            </div>`
          : emptyState('◔', 'No spending recorded', 'Add a transaction in Money to see your category mix.')}
      </div>
    </div>

    <div class="grid grid-main" style="margin-bottom:18px">
      <div class="card">
        <div class="card-head"><div><h3>Recent activity</h3><div class="card-sub">Newest records across the workspace</div></div></div>
        ${activity.length ? `<div class="kv-list">${activity.map(a => `<div class="kv">
          <span><b>${esc(a.title)}</b> <span class="tag-pill">${esc(a.kind)}</span><br/><span class="tiny">${esc(dateLabel(a.date, { short: true }))}</span></span>
          <b class="${signClass(a.amount)}">${a.amount ? esc(fmt(a.amount)) : '—'}</b></div>`).join('')}</div>`
          : emptyState('◷', 'Nothing recorded yet', 'Add employees, invoices, transactions or records to build your activity feed.')}
      </div>
      <div class="card">
        <div class="card-head"><div><h3>Upcoming dates</h3><div class="card-sub">Debts, invoices and records</div></div><a class="btn btn-sm" href="${ROUTES.details}">All records →</a></div>
        ${upcoming.length ? `<div class="stack" style="gap:10px">${upcoming.map(u => `<div class="kv">
          <span><b>${esc(u.title)}</b><br/><span class="tiny">${esc(u.kind)} · ${esc(dateLabel(u.date, { short: true }))}</span></span>
          <b>${daysBadge(u.date)}${u.amount ? `<br/><span class="tiny">${esc(fmt(u.amount))}</span>` : ''}</b></div>`).join('')}</div>`
          : emptyState('◷', 'No upcoming dates', 'Add a debt due date, invoice due date or record reminder.')}
      </div>
    </div>

    <div class="card" style="margin-bottom:18px"><div class="card-head"><div><h3>Retirement snapshot</h3><div class="card-sub">Manual plans and employee accounts</div></div>
      <a class="btn btn-sm" href="${ROUTES.retirement}">Manage →</a></div>
      <div class="kv-list">
        <div class="kv"><span>Total plan balance</span><b>${esc(fmt(retirement.balance))}</b></div>
        <div class="kv"><span>Employer YTD</span><b>${esc(fmt(retirement.employerYTD))}</b></div>
        <div class="kv"><span>Employee YTD</span><b>${esc(fmt(retirement.employeeYTD))}</b></div>
        <div class="kv"><span>Participation</span><b>${retirement.participation} active account${retirement.participation === 1 ? '' : 's'}</b></div>
      </div>
      <div class="data-note">Plan formulas and account balances are entered by hand; no payroll or provider connection is used.</div>
    </div>

    <div class="card"><div class="card-head"><div><h3>Quick actions</h3><div class="card-sub">All data is entered manually</div></div></div>${quickActions()}
      ${manualNote('Bank balances, payroll figures and tax or insurance reminders here are <b>manually entered</b>. Atlas Business does not connect to banks, payroll providers or tax accounts.')}
    </div>`;
}

/* ------------------------------- employees ------------------------------- */

function employeeRows(d) {
  const f = state.filters.employees;
  const q = f.search.trim().toLowerCase();
  const rows = d.employees.filter(e => {
    if (e.archived) return false;
    if (f.department !== 'all' && (e.department || 'Other') !== f.department) return false;
    if (f.status !== 'all' && (e.status || 'active') !== f.status) return false;
    return !q || `${e.name || ''} ${e.role || ''} ${e.email || ''} ${e.department || ''}`.toLowerCase().includes(q);
  });
  if (!rows.length) return `<tr><td colspan="9">${emptyState('♙', 'No matching employees', 'Add a person or change the filters above.', `<button class="btn btn-primary btn-sm" data-action="add-employee">Add employee</button>`)}</td></tr>`;
  return rows.map(e => `<tr>
    <td><div class="sym-cell"><span class="sym-logo" style="background:${esc(colorFor(e.name || 'E'))}">${esc(initials(e.name || '?'))}</span>
      <span><strong>${esc(e.name || 'Unnamed employee')}</strong><small>${esc(e.email || 'No email on file')}</small></span></div></td>
    <td>${esc(e.role || '—')}</td><td><span class="tag-pill">${esc(e.department || 'Other')}</span></td>
    <td>${esc(e.payType || 'salary')} · ${esc(fmt(e.rate, 0))}</td><td>${esc(e.payFrequency || 'biweekly')}</td>
    <td>${esc(dateLabel(e.startDate, { short: true }))}</td><td>${statusBadge(e.status || 'active')}</td>
    <td>${esc(fmt(annualCost(e), 0))}</td>
    <td><div class="row-actions"><button class="btn btn-sm" data-action="edit-employee" data-id="${esc(e.id)}">Edit</button>
      <button class="btn btn-sm" data-action="archive-employee" data-id="${esc(e.id)}">Archive</button>
      <button class="btn btn-sm btn-danger" data-action="delete-employee" data-id="${esc(e.id)}">✕</button></div></td>
  </tr>`).join('');
}

function employeesView(d) {
  const active = activeEmployees(d);
  const departments = [...new Set(d.employees.map(e => e.department || 'Other'))].sort();
  const f = state.filters.employees;
  return `${pageHead('Employees', 'People records with manual pay details — kept separate from any payroll provider.', `<button class="btn btn-primary" data-action="add-employee">＋ Add employee</button>`)}
    <div class="grid grid-4" style="margin-bottom:18px">
      <div class="card stat-card"><div class="stat-label">Active employees</div><div class="stat-value">${active.length}</div><div class="stat-foot">${d.employees.length} total records</div></div>
      <div class="card stat-card"><div class="stat-label">Departments</div><div class="stat-value">${departments.length}</div><div class="stat-foot">${departments.slice(0, 3).map(esc).join(', ') || 'None yet'}</div></div>
      <div class="card stat-card"><div class="stat-label">Monthly payroll</div><div class="stat-value" style="font-size:24px">${esc(fmt(monthlyPayroll(d)))}</div><div class="stat-foot">Estimated from pay details</div></div>
      <div class="card stat-card"><div class="stat-label">Annual payroll</div><div class="stat-value" style="font-size:24px">${esc(fmt(monthlyPayroll(d) * 12))}</div><div class="stat-foot">Gross estimate</div></div>
    </div>
    <div class="manual-note" style="margin-bottom:18px"><span class="ic">✎</span><span><b>Payroll data is manually entered.</b> Add salary or hourly rates yourself; nothing is imported from a payroll provider and nothing leaves this browser unless cloud sync is explicitly configured.</span></div>
    <div class="card" style="margin-bottom:18px"><div class="filter-bar">
      <div class="field"><label for="emp-search">Search</label><input class="input" id="emp-search" placeholder="Name, role, email…" value="${esc(f.search)}"/></div>
      <div class="field"><label for="emp-department">Department</label><select class="input" id="emp-department"><option value="all">All departments</option>${options(departments, f.department)}</select></div>
      <div class="field"><label for="emp-status">Status</label><select class="input" id="emp-status"><option value="all">All statuses</option>${options(EMPLOYEE_STATUSES, f.status)}</select></div>
      <div class="field"><label>&nbsp;</label><button class="btn" data-action="reset-employee-filters">Clear filters</button></div>
    </div></div>
    <div class="card"><div class="card-head"><div><h3>All employees</h3><div class="card-sub" id="emp-count">${d.employees.filter(e => !e.archived).length} active record(s)</div></div></div>
      <div class="table-scroll"><table class="data"><thead><tr><th>Employee</th><th>Role</th><th>Department</th><th>Pay</th><th>Frequency</th><th>Start</th><th>Status</th><th>Annual cost</th><th>Actions</th></tr></thead>
      <tbody id="employee-tbody">${employeeRows(d)}</tbody></table></div>
    </div>
    ${d.employees.some(e => e.archived) ? `<div class="card" style="margin-top:18px"><div class="card-head"><h3>Archived</h3><span class="tag-pill">${d.employees.filter(e => e.archived).length}</span></div>
      <div class="kv-list">${d.employees.filter(e => e.archived).map(e => `<div class="kv"><span>${esc(e.name)}</span><b><button class="btn btn-sm" data-action="unarchive-employee" data-id="${esc(e.id)}">Restore</button></b></div>`).join('')}</div></div>` : ''}`;
}

/* ------------------------------- payroll ------------------------------- */

function payrollTotals(run) {
  const items = Array.isArray(run?.items) ? run.items : [];
  return {
    gross: sum(items, 'gross'), deductions: sum(items, 'deductions'),
    taxes: sum(items, 'taxes'), net: sum(items, 'net'), count: items.length,
  };
}

function payrollCard(run, d) {
  const t = payrollTotals(run);
  return `<div class="card" style="margin-bottom:18px">
    <div class="card-head"><div><h3>Period ${esc(dateLabel(run.periodStart, { short: true }))} – ${esc(dateLabel(run.periodEnd, { short: true }))}</h3>
      <div class="card-sub">Pay date ${esc(dateLabel(run.payDate, { short: true }))} · ${t.count} employee${t.count === 1 ? '' : 's'}</div></div>
      <div class="btn-row">${statusBadge(run.status || 'draft')}
        ${run.status === 'draft' ? `<button class="btn btn-sm" data-action="generate-payroll" data-id="${esc(run.id)}">Generate items</button>
          <button class="btn btn-primary btn-sm" data-action="approve-payroll" data-id="${esc(run.id)}">Approve</button>` : ''}
        ${run.status === 'approved' ? `<button class="btn btn-copper btn-sm" data-action="mark-payroll-paid" data-id="${esc(run.id)}">Mark paid</button>` : ''}
        <button class="btn btn-sm" data-action="edit-payroll" data-id="${esc(run.id)}">Edit period</button>
        <button class="btn btn-sm" data-action="export-payroll" data-id="${esc(run.id)}">CSV</button>
        <button class="btn btn-sm btn-danger" data-action="delete-payroll" data-id="${esc(run.id)}">✕</button>
      </div></div>
    ${t.count ? `<div class="table-scroll"><table class="data"><thead><tr><th>Employee</th><th>Gross</th><th>Deductions</th><th>Taxes</th><th>Net</th><th>Actions</th></tr></thead><tbody>
      ${run.items.map(item => {
        const emp = d.employees.find(e => e.id === item.employeeId);
        return `<tr><td><div class="sym-cell"><span class="sym-logo" style="background:${esc(colorFor(emp?.name || 'E'))}">${esc(initials(emp?.name || '?'))}</span>
          <span><strong>${esc(emp?.name || 'Removed employee')}</strong><small>${esc(emp?.role || 'Manual record')}</small></span></div></td>
          <td>${esc(fmt(item.gross))}</td><td>−${esc(fmt(item.deductions))}</td><td>−${esc(fmt(item.taxes))}</td><td><b>${esc(fmt(item.net))}</b></td>
          <td><div class="row-actions"><button class="btn btn-sm" data-action="edit-payroll-item" data-id="${esc(run.id)}" data-item="${esc(item.employeeId)}">Edit</button>
            <button class="btn btn-sm btn-danger" data-action="remove-payroll-item" data-id="${esc(run.id)}" data-item="${esc(item.employeeId)}">✕</button></div></td></tr>`;
      }).join('')}
      <tr><td><b>Totals</b></td><td><b>${esc(fmt(t.gross))}</b></td><td>−${esc(fmt(t.deductions))}</td><td>−${esc(fmt(t.taxes))}</td><td><b>${esc(fmt(t.net))}</b></td><td></td></tr>
    </tbody></table></div>` : emptyState('▤', 'No payroll items yet', 'Generate items from your active employees to build this run.', `<button class="btn btn-primary btn-sm" data-action="generate-payroll" data-id="${esc(run.id)}">Generate items</button>`)}
    ${run.notes ? `<p class="muted small" style="margin-top:14px">${esc(run.notes)}</p>` : ''}
  </div>`;
}

function payrollView(d) {
  const runs = [...d.payroll].sort((a, b) => String(b.payDate || '').localeCompare(String(a.payDate || '')));
  const paid = runs.filter(r => r.status === 'paid');
  const drafts = runs.filter(r => r.status === 'draft');
  return `${pageHead('Payroll', 'Create periods, generate items and approve manually entered pay runs.', `<button class="btn btn-primary" data-action="new-payroll">＋ New pay period</button>`)}
    <div class="grid grid-4" style="margin-bottom:18px">
      <div class="card stat-card"><div class="stat-label">Pay runs</div><div class="stat-value">${runs.length}</div><div class="stat-foot">${drafts.length} in draft</div></div>
      <div class="card stat-card"><div class="stat-label">Latest net pay</div><div class="stat-value" style="font-size:24px">${esc(fmt(payrollTotals(runs[0] || {}).net))}</div><div class="stat-foot">Most recent period</div></div>
      <div class="card stat-card"><div class="stat-label">Paid runs</div><div class="stat-value">${paid.length}</div><div class="stat-foot">Marked paid manually</div></div>
      <div class="card stat-card"><div class="stat-label">Monthly payroll</div><div class="stat-value" style="font-size:24px">${esc(fmt(monthlyPayroll(d)))}</div><div class="stat-foot">From employee records</div></div>
    </div>
    ${manualNote('Payroll figures are <b>manually entered</b> and exported as CSV in your browser. No payroll data is transmitted unless you explicitly configure cloud sync with Atlas Sync.')}
    <div style="height:18px"></div>
    ${runs.length ? runs.map(run => payrollCard(run, d)).join('')
      : emptyState('▤', 'No pay periods yet', 'Create a pay period, then generate items from your active employees.', `<button class="btn btn-primary" data-action="new-payroll">Create a pay period</button>`)}`;
}

/* -------------------------------- debts -------------------------------- */

function debtCard(debt, d) {
  const original = Math.max(0, Number(debt.original) || 0);
  const balance = Math.max(0, Number(debt.balance) || 0);
  const progress = original > 0 ? Math.min(100, Math.max(0, (1 - balance / original) * 100)) : 0;
  const projection = payoffProjection(debt);
  const paid = sum(d.debtPayments.filter(p => p.debtId === debt.id), 'amount');
  return `<div class="card">
    <div class="detail-top"><div><h3>${esc(debt.name || 'Unnamed debt')}</h3>
      <div class="card-sub">${esc(debt.type || 'loan')} · ${esc(debt.creditor || 'No creditor')} · ${esc(debt.priority || 'medium')} priority</div></div>
      ${daysBadge(debt.dueDate)}</div>
    <div style="margin:16px 0"><div class="budget-meta"><span>${esc(fmt(balance))} remaining</span><span>${progress.toFixed(0)}% paid</span></div>
      <div class="progress"><span style="width:${progress.toFixed(1)}%"></span></div></div>
    <div class="kv-list">
      <div class="kv"><span>Balance / original</span><b>${esc(fmt(balance))} / ${esc(fmt(original))}</b></div>
      <div class="kv"><span>Rate · minimum</span><b>${esc(num(debt.rate || 0, 2))}% · ${esc(fmt(debt.minimumPayment))}/mo</b></div>
      <div class="kv"><span>Payoff estimate</span><b>${esc(monthsLabel(projection.months))}${projection.paid ? '' : '+'}</b></div>
      <div class="kv"><span>Est. interest remaining</span><b>${esc(fmt(projection.interest))}</b></div>
      <div class="kv"><span>Payments recorded</span><b>${esc(fmt(paid))}</b></div>
      <div class="kv"><span>Due date</span><b>${esc(debt.dueDate ? dateLabel(debt.dueDate, { short: true }) : 'Not set')}</b></div>
    </div>
    ${debt.notes ? `<p class="muted small" style="margin-top:12px">${esc(debt.notes)}</p>` : ''}
    <div class="btn-row" style="margin-top:16px"><button class="btn btn-primary btn-sm" data-action="record-debt-payment" data-id="${esc(debt.id)}">Record payment</button>
      <button class="btn btn-sm" data-action="edit-debt" data-id="${esc(debt.id)}">Edit</button>
      <button class="btn btn-sm btn-danger" data-action="delete-debt" data-id="${esc(debt.id)}">✕</button></div>
  </div>`;
}

function debtsView(d) {
  const projections = d.debts.map(debt => payoffProjection(debt));
  const horizon = projections.length ? Math.max(...projections.map(p => p.months)) : 0;
  const payments = [...d.debtPayments].sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))).slice(0, 8);
  return `${pageHead('Debts', 'Balances, rates and manually recorded payments with simple payoff estimates.', `<button class="btn btn-primary" data-action="add-debt">＋ Add debt</button>`)}
    <div class="grid grid-4" style="margin-bottom:18px">
      <div class="card stat-card"><div class="stat-label">Total balance</div><div class="stat-value down">${esc(fmt(totalDebt(d)))}</div><div class="stat-foot">${d.debts.length} debt${d.debts.length === 1 ? '' : 's'}</div></div>
      <div class="card stat-card"><div class="stat-label">Monthly debt service</div><div class="stat-value" style="font-size:24px">${esc(fmt(monthlyDebtService(d)))}</div><div class="stat-foot">Sum of minimum payments</div></div>
      <div class="card stat-card"><div class="stat-label">Longest payoff</div><div class="stat-value" style="font-size:24px">${d.debts.length ? esc(monthsLabel(horizon)) : '—'}</div><div class="stat-foot">At current minimums</div></div>
      <div class="card stat-card"><div class="stat-label">Payments recorded</div><div class="stat-value">${d.debtPayments.length}</div><div class="stat-foot">${esc(fmt(sum(d.debtPayments, 'amount')))} total</div></div>
    </div>
    ${manualNote('Debt balances, rates and payments are <b>manually entered</b>. Payoff estimates assume a fixed minimum payment and monthly compounding interest; they are planning figures, not financial advice.')}
    <div style="height:18px"></div>
    <div class="grid grid-2">
      ${d.debts.length ? d.debts.map(debt => debtCard(debt, d)).join('')
        : `<div style="grid-column:1/-1">${emptyState('◇', 'No debts yet', 'Add a loan, card, line of credit or vendor balance to start tracking payoff.', `<button class="btn btn-primary" data-action="add-debt">Add a debt</button>`)}</div>`}
    </div>
    <div class="card" style="margin-top:18px"><div class="card-head"><div><h3>Recent payments</h3><div class="card-sub">Newest first</div></div></div>
      ${payments.length ? `<div class="kv-list">${payments.map(p => `<div class="kv"><span>${esc(dateLabel(p.date, { short: true }))} · ${esc(d.debts.find(x => x.id === p.debtId)?.name || 'Debt')}</span><b>${esc(fmt(p.amount))}${p.note ? `<br/><span class="tiny">${esc(p.note)}</span>` : ''}</b></div>`).join('')}</div>`
        : emptyState('◷', 'No payments recorded', 'Record a payment against a debt to see it here.')}
    </div>`;
}

/* -------------------------------- money -------------------------------- */

function moneyTabs() {
  return `<div class="tabs">${[['accounts', 'Accounts'], ['transactions', 'Transactions'], ['budgets', 'Budgets']]
    .map(([key, label]) => `<button class="tab ${active(state.moneyTab, key)}" data-action="money-tab" data-tab="${key}">${label}</button>`).join('')}</div>`;
}

function accountsSection(d) {
  const activeAccounts = d.accounts.filter(a => !a.archived);
  const totals = ACCOUNT_TYPES.map(type => ({
    type, value: sum(activeAccounts.filter(a => a.type === type), 'balance'),
    count: activeAccounts.filter(a => a.type === type).length,
  })).filter(x => x.count);
  return `${totals.length ? `<div class="grid grid-4" style="margin-bottom:18px">${totals.map(t => `<div class="card stat-card"><div class="stat-label">${esc(t.type)}</div><div class="stat-value" style="font-size:22px">${esc(fmt(t.value))}</div><div class="stat-foot">${t.count} account${t.count === 1 ? '' : 's'}</div></div>`).join('')}</div>` : ''}
    <div class="grid grid-3">
      ${activeAccounts.length ? activeAccounts.map(a => `<div class="card account-card">
        <span class="account-stripe" style="background:${esc(safeColor(a.color))}"></span>
        <div class="account-top"><span class="account-icon" style="background:${esc(safeColor(a.color))}">${esc((a.name || '?')[0].toUpperCase())}</span>
          <div><h3>${esc(a.name)}</h3><p>${esc(a.institution || 'Manual entry')}${a.mask ? ` · ••${esc(a.mask)}` : ''}</p></div></div>
        <div><div class="stat-label">Current balance</div><div class="account-balance">${esc(fmt(a.balance))}</div></div>
        <div class="account-actions"><span class="tag-pill">${esc(a.type || 'Other')}</span>
          <button class="btn btn-sm" data-action="edit-account" data-id="${esc(a.id)}">Edit</button>
          <button class="btn btn-sm" data-action="archive-account" data-id="${esc(a.id)}">Archive</button>
          <button class="btn btn-sm btn-danger" data-action="delete-account-row" data-id="${esc(a.id)}">✕</button></div>
      </div>`).join('') : `<div style="grid-column:1/-1">${emptyState('▤', 'No accounts yet', 'Add an operating, payroll, tax or savings account by hand.', `<button class="btn btn-primary" data-action="add-account">Add your first account</button>`)}</div>`}
    </div>
    ${d.accounts.some(a => a.archived) ? `<div class="card" style="margin-top:18px"><div class="card-head"><h3>Archived accounts</h3></div>
      <div class="kv-list">${d.accounts.filter(a => a.archived).map(a => `<div class="kv"><span>${esc(a.name)} · ${esc(a.type)}</span><b>${esc(fmt(a.balance))} <button class="btn btn-sm" data-action="unarchive-account" data-id="${esc(a.id)}">Restore</button></b></div>`).join('')}</div></div>` : ''}`;
}

function transactionRows(d) {
  const f = state.filters.transactions;
  const q = f.search.trim().toLowerCase();
  const rows = sortedTransactions(d).filter(t => {
    if (f.account !== 'all' && t.accountId !== f.account) return false;
    if (f.category !== 'all' && (t.category || 'Other') !== f.category) return false;
    if (f.type !== 'all' && t.type !== f.type) return false;
    return !q || `${t.description || ''} ${t.category || ''} ${t.date || ''}`.toLowerCase().includes(q);
  });
  const map = runningBalances(d);
  if (!rows.length) return `<tr><td colspan="7">${emptyState('↔', 'No matching transactions', 'Try a different filter or add a transaction.')}</td></tr>`;
  return rows.map(t => {
    const acc = d.accounts.find(a => a.id === t.accountId);
    const amount = effectiveAmount(t);
    return `<tr><td><div class="sym-cell"><span class="sym-logo" style="background:${esc(safeColor(acc?.color))}">${esc((acc?.name || '?')[0].toUpperCase())}</span>
      <span><strong>${esc(t.description || 'Untitled transaction')}</strong><small>${esc(dateLabel(t.date, { short: true }))} · ${esc(acc?.name || 'Unassigned')}</small></span></div></td>
      <td><span class="tag-pill">${esc(t.category || 'Other')}</span></td><td>${statusBadge(t.type || 'expense')}</td>
      <td class="${signClass(amount)}">${esc(fmt(amount))}</td><td class="muted">${map[t.id] != null ? esc(fmt(map[t.id])) : '—'}</td>
      <td><div class="row-actions"><button class="btn btn-sm" data-action="edit-transaction" data-id="${esc(t.id)}">Edit</button>
        <button class="btn btn-sm btn-danger" data-action="delete-transaction" data-id="${esc(t.id)}">✕</button></div></td></tr>`;
  }).join('');
}

function transactionsSection(d) {
  const f = state.filters.transactions;
  return `<div class="card" style="margin-bottom:18px"><div class="filter-bar">
      <div class="field"><label for="tx-search">Search</label><input class="input" id="tx-search" placeholder="Description, category, date…" value="${esc(f.search)}"/></div>
      <div class="field"><label for="tx-account">Account</label><select class="input" id="tx-account"><option value="all">All accounts</option>${d.accounts.map(a => `<option value="${esc(a.id)}" ${selected(a.id, f.account)}>${esc(a.name)}</option>`).join('')}</select></div>
      <div class="field"><label for="tx-category">Category</label><select class="input" id="tx-category"><option value="all">All categories</option>${options(CATEGORIES, f.category)}</select></div>
      <div class="field"><label for="tx-type">Type</label><select class="input" id="tx-type"><option value="all">All types</option>${options(TRANSACTION_TYPES, f.type)}</select></div>
    </div></div>
    <div class="card"><div class="card-head"><div><h3>All transactions</h3><div class="card-sub" id="tx-count">${d.transactions.length} record(s)</div></div>
      <div class="data-note">Running balance is estimated from each account’s current balance.</div></div>
      <div class="table-scroll"><table class="data"><thead><tr><th>Transaction</th><th>Category</th><th>Type</th><th>Amount</th><th>Running balance</th><th>Actions</th></tr></thead>
      <tbody id="tx-tbody">${transactionRows(d)}</tbody></table></div></div>`;
}

function budgetsSection(d) {
  const rows = d.budgets.map(b => ({ ...b, spent: budgetSpent(b, d) }));
  const chartItems = rows.slice(0, 6).map(b => ({
    label: b.category, value: Math.max(0, b.spent),
    color: b.spent > Number(b.limit) ? '#f0837f' : colorFor(b.category), display: fmt(b.spent, 0),
  }));
  return `<div class="grid grid-main">
    <div class="grid grid-2" style="align-content:start">
      ${rows.length ? rows.map(b => {
        const limit = Number(b.limit) || 0;
        const p = limit > 0 ? b.spent / limit * 100 : 0;
        return `<div class="card"><div class="budget-top"><div><h3>${esc(b.category)}</h3><div class="card-sub">${esc(b.period)} limit</div></div>
          <div class="row-actions"><button class="btn btn-sm" data-action="edit-budget" data-id="${esc(b.id)}">Edit</button>
            <button class="btn btn-sm btn-danger" data-action="delete-budget" data-id="${esc(b.id)}">✕</button></div></div>
          <div style="margin-top:18px"><div class="budget-meta"><span>${p >= 100 ? `<span class="over-budget">${(p - 100).toFixed(0)}% over</span>` : `${Math.max(0, 100 - p).toFixed(0)}% left`}</span>
            <span>${esc(fmt(b.spent, 0))} / ${esc(fmt(limit, 0))}</span></div>
            <div class="progress ${p >= 100 ? 'over' : ''}"><span style="width:${Math.min(p, 100).toFixed(1)}%"></span></div></div></div>`;
      }).join('') : `<div style="grid-column:1/-1">${emptyState('◈', 'No budgets yet', 'Give a category a monthly or weekly limit.', `<button class="btn btn-primary" data-action="add-budget">Create a budget</button>`)}</div>`}
    </div>
    <div class="stack"><div class="card"><div class="card-head"><h3>Spending by budget</h3></div>${bars(chartItems)}</div>
      <div class="notice">Budgets use manually entered expense transactions in the current month (or last 7 days for weekly budgets). Transfers and income never count as spending.</div></div>
  </div>`;
}

function moneyView(d) {
  const buttons = {
    accounts: `<button class="btn btn-primary" data-action="add-account">＋ Add account</button>`,
    transactions: `<button class="btn btn-primary" data-action="add-transaction">＋ Add transaction</button>`,
    budgets: `<button class="btn btn-primary" data-action="add-budget">＋ New budget</button>`,
  };
  return `${pageHead('Money', 'Manual business accounts, transactions and budgets — no bank login required.', buttons[state.moneyTab])}
    ${manualNote('Bank data here is <b>manually entered</b>. Atlas Business does not store bank credentials or connect to financial institutions.')}
    <div style="height:18px"></div>${moneyTabs()}
    ${state.moneyTab === 'accounts' ? accountsSection(d) : state.moneyTab === 'transactions' ? transactionsSection(d) : budgetsSection(d)}`;
}

/* ------------------------------- invoices ------------------------------- */

function invoicesView(d) {
  const rows = [...d.invoices].sort((a, b) => String(a.dueDate || '').localeCompare(String(b.dueDate || '')));
  const byStatus = INVOICE_STATUSES.map(s => ({ status: s, value: sum(d.invoices.filter(i => i.status === s), 'amount'), count: d.invoices.filter(i => i.status === s).length }));
  const overdue = d.invoices.filter(i => i.status === 'overdue' || (i.status !== 'paid' && daysUntil(i.dueDate) < 0));
  return `${pageHead('Invoices', 'Track who owes you, what is overdue and what is coming due.', `<button class="btn btn-primary" data-action="add-invoice">＋ New invoice</button>`)}
    <div class="grid grid-4" style="margin-bottom:18px">${byStatus.map(x => `<div class="card stat-card"><div class="stat-label">${esc(x.status)}</div><div class="stat-value" style="font-size:24px">${esc(fmt(x.value))}</div><div class="stat-foot">${x.count} invoice${x.count === 1 ? '' : 's'}</div></div>`).join('')}</div>
    ${overdue.length ? `<div class="notice warn" style="margin-bottom:18px"><b>${overdue.length} overdue invoice${overdue.length === 1 ? '' : 's'}.</b> ${esc(overdue.map(i => i.client || 'Unnamed client').join(', '))}</div>` : ''}
    <div class="card"><div class="card-head"><div><h3>All invoices</h3><div class="card-sub">Sorted by due date</div></div></div>
      ${rows.length ? `<div class="table-scroll"><table class="data"><thead><tr><th>Client</th><th>Issued</th><th>Due</th><th>Amount</th><th>Status</th><th>Actions</th></tr></thead><tbody>
        ${rows.map(i => `<tr><td><div class="sym-cell"><span class="sym-logo" style="background:${esc(colorFor(i.client || 'C'))}">${esc(initials(i.client || '?'))}</span>
          <span><strong>${esc(i.client || 'Unnamed client')}</strong><small>${esc(i.notes || 'Manual invoice')}</small></span></div></td>
          <td>${esc(dateLabel(i.issueDate, { short: true }))}</td><td>${esc(dateLabel(i.dueDate, { short: true }))} ${daysBadge(i.dueDate)}</td>
          <td><b>${esc(fmt(i.amount))}</b></td><td>${statusBadge(i.status || 'draft')}</td>
          <td><div class="row-actions">${i.status !== 'paid' ? `<button class="btn btn-sm" data-action="pay-invoice" data-id="${esc(i.id)}">Mark paid</button>` : ''}
            <button class="btn btn-sm" data-action="edit-invoice" data-id="${esc(i.id)}">Edit</button>
            <button class="btn btn-sm btn-danger" data-action="delete-invoice" data-id="${esc(i.id)}">✕</button></div></td></tr>`).join('')}
      </tbody></table></div>` : emptyState('▧', 'No invoices yet', 'Add a client, amount and due date to start tracking receivables.', `<button class="btn btn-primary" data-action="add-invoice">New invoice</button>`)}
    </div>`;
}

/* ------------------------------- expenses ------------------------------- */

function expenseRows(d) {
  const f = state.filters.expenses;
  const q = f.search.trim().toLowerCase();
  const rows = [...d.expenses].sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))).filter(e => {
    if (f.status !== 'all' && (e.status || 'pending') !== f.status) return false;
    return !q || `${e.vendor || ''} ${e.category || ''} ${e.notes || ''}`.toLowerCase().includes(q);
  });
  if (!rows.length) return `<tr><td colspan="7">${emptyState('◈', 'No matching expenses', 'Add a vendor expense or change the filters.')}</td></tr>`;
  return rows.map(e => `<tr>
    <td><div class="sym-cell"><span class="sym-logo" style="background:${esc(colorFor(e.vendor || 'V'))}">${esc(initials(e.vendor || '?'))}</span>
      <span><strong>${esc(e.vendor || 'Unnamed vendor')}</strong><small>${esc(e.notes || 'Manual expense')}</small></span></div></td>
    <td>${esc(dateLabel(e.date, { short: true }))}</td><td><span class="tag-pill">${esc(e.category || 'Other')}</span></td>
    <td>${esc(d.accounts.find(a => a.id === e.accountId)?.name || 'Unassigned')}</td>
    <td><b>${esc(fmt(e.amount))}</b></td><td>${statusBadge(e.status || 'pending')}</td>
    <td><div class="row-actions"><button class="btn btn-sm" data-action="edit-expense" data-id="${esc(e.id)}">Edit</button>
      <button class="btn btn-sm btn-danger" data-action="delete-expense" data-id="${esc(e.id)}">✕</button></div></td></tr>`).join('');
}

function expensesView(d) {
  const pending = sum(d.expenses.filter(e => e.status !== 'paid'), 'amount');
  const paid = sum(d.expenses.filter(e => e.status === 'paid'), 'amount');
  const byVendor = {};
  d.expenses.forEach(e => { const k = e.vendor || 'Unnamed vendor'; byVendor[k] = (byVendor[k] || 0) + (Number(e.amount) || 0); });
  const topVendors = Object.entries(byVendor).map(([label, value], i) => ({ label, value, color: CHART_COLORS[i % CHART_COLORS.length], display: fmt(value, 0) }))
    .sort((a, b) => b.value - a.value).slice(0, 6);
  const f = state.filters.expenses;
  return `${pageHead('Expenses', 'Vendor spending, payables and payment status.', `<button class="btn btn-primary" data-action="add-expense">＋ Add expense</button>`)}
    <div class="grid grid-3" style="margin-bottom:18px">
      <div class="card stat-card"><div class="stat-label">Payables pending</div><div class="stat-value down">${esc(fmt(pending))}</div><div class="stat-foot">${d.expenses.filter(e => e.status !== 'paid').length} unpaid</div></div>
      <div class="card stat-card"><div class="stat-label">Paid expenses</div><div class="stat-value up">${esc(fmt(paid))}</div><div class="stat-foot">${d.expenses.filter(e => e.status === 'paid').length} paid</div></div>
      <div class="card stat-card"><div class="stat-label">All recorded</div><div class="stat-value" style="font-size:24px">${esc(fmt(pending + paid))}</div><div class="stat-foot">${d.expenses.length} records</div></div>
    </div>
    <div class="grid grid-main">
      <div class="card"><div class="card-head"><div><h3>All expenses</h3><div class="card-sub" id="expense-count">${d.expenses.length} record(s)</div></div></div>
        <div class="filter-bar" style="grid-template-columns:1fr 180px;margin-bottom:16px">
          <div class="field"><label for="expense-search">Search</label><input class="input" id="expense-search" placeholder="Vendor, category, note…" value="${esc(f.search)}"/></div>
          <div class="field"><label for="expense-status">Status</label><select class="input" id="expense-status"><option value="all">All statuses</option>${options(EXPENSE_STATUSES, f.status)}</select></div>
        </div>
        <div class="table-scroll"><table class="data"><thead><tr><th>Vendor</th><th>Date</th><th>Category</th><th>Account</th><th>Amount</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody id="expense-tbody">${expenseRows(d)}</tbody></table></div>
      </div>
      <div class="card"><div class="card-head"><h3>Top vendors</h3><span class="tag-pill">By recorded spend</span></div>${bars(topVendors)}</div>
    </div>`;
}

/* ----------------------------- investments ----------------------------- */

function investmentsView(d) {
  const m = meridianParts(d);
  const linked = !!d.investments && d.settings.linkedMeridian;
  const rows = m.holdings;
  const total = sum(rows.map(holdingValue));
  return `${pageHead('Investments', 'A read-only investing view imported from Meridian — no second login.', `<a class="btn btn-primary" href="${ROUTES.connections}">⚯ Manage connection</a>`)}
    ${linked ? `<div class="grid grid-3" style="margin-bottom:18px">
      <div class="card stat-card"><div class="stat-label">Holdings</div><div class="stat-value">${rows.length}</div><div class="stat-foot">From Meridian snapshot</div></div>
      <div class="card stat-card"><div class="stat-label">Investment value</div><div class="stat-value" style="font-size:24px">${esc(fmt(total))}</div><div class="stat-foot">Included in net position</div></div>
      <div class="card stat-card"><div class="stat-label">Snapshot saved</div><div class="stat-value" style="font-size:22px">${esc(m.updatedAt ? dateLabel(m.updatedAt, { short: true }) : 'Imported')}</div><div class="stat-foot">Read-only</div></div>
    </div>` : ''}
    <div class="card">
      <div class="card-head"><div><h3>Holdings</h3><div class="card-sub">Imported manually via a pairing code</div></div>${linked ? '<span class="badge live">Linked</span>' : ''}</div>
      ${linked && rows.length ? `<div class="table-scroll"><table class="data"><thead><tr><th>Symbol</th><th>Name</th><th>Quantity</th><th>Price</th><th>Value</th></tr></thead><tbody>
        ${rows.map(h => `<tr><td><b>${esc(h.symbol || h.ticker || '—')}</b></td><td>${esc(h.name || h.company || '—')}</td>
          <td>${esc(num(h.quantity ?? h.shares ?? h.qty ?? 0, 4))}</td>
          <td>${esc(fmt(h.price ?? h.last ?? h.lastPrice ?? 0))}</td><td><b>${esc(fmt(holdingValue(h)))}</b></td></tr>`).join('')}
      </tbody></table></div>` : emptyState('↗', linked ? 'No holdings in this snapshot' : 'No Meridian snapshot yet',
        linked ? 'The linked snapshot does not contain holdings.' : 'Redeem a pairing code in Connections to bring a read-only Meridian snapshot here. No Meridian password is needed.',
        `<a class="btn btn-primary" href="${ROUTES.connections}">Go to Connections →</a>`)}
      ${linked ? `<div class="data-note">Snapshot ${esc(dateLabel(m.updatedAt || Date.now(), { relative: true }))}. Values are read-only and cannot be edited in Atlas Business.</div>` : ''}
    </div>`;
}

/* -------------------------------- shared -------------------------------- */

function groupCard(group, d) {
  const expenses = d.sharedExpenses.filter(x => x.groupId === group.id)
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  const balances = groupBalances(group, d);
  const settlements = settleUp(balances);
  return `<div class="card">
    <div class="card-head"><div><h3>${esc(group.name || 'Untitled group')}</h3>
      <div class="card-sub">${groupMembers(group).map(m => esc(m.name)).join(' · ') || 'No members yet'}</div></div>
      <div class="btn-row"><span class="tag-pill">${expenses.length} expense${expenses.length === 1 ? '' : 's'}</span>
        <button class="btn btn-sm" data-action="edit-group" data-id="${esc(group.id)}">Edit</button>
        <button class="btn btn-sm btn-danger" data-action="delete-group" data-id="${esc(group.id)}">✕</button></div></div>
    <div class="btn-row" style="margin-bottom:16px"><button class="btn btn-primary btn-sm" data-action="add-shared-expense" data-id="${esc(group.id)}">＋ Add shared expense</button></div>
    ${expenses.length ? `<div class="kv-list" style="margin-bottom:16px">${expenses.map(exp => {
      const payer = groupMembers(group).find(m => m.id === exp.payerId)?.name || 'Unknown';
      return `<div class="kv"><span><b>${esc(exp.title || 'Shared expense')}</b><br/><span class="tiny">${esc(dateLabel(exp.date, { short: true }))} · ${esc(payer)} paid · ${esc(exp.split)} split</span></span>
        <b>${esc(fmt(exp.amount))} <button class="btn btn-sm btn-danger" data-action="delete-shared-expense" data-id="${esc(exp.id)}">✕</button></b></div>`;
    }).join('')}</div>` : `<p class="muted small">No shared expenses in this group yet.</p>`}
    <div class="card-head" style="margin-bottom:10px"><h3 style="font-size:14px">Who owes whom</h3></div>
    ${settlements.length ? `<div class="stack" style="gap:8px">${settlements.map(s => `<div class="settle-row"><span><b>${esc(s.from)}</b> → <b>${esc(s.to)}</b></span><b>${esc(fmt(s.amount))}</b></div>`).join('')}</div>`
      : `<p class="muted small">Everyone is settled up.</p>`}
    ${Object.keys(balances).length ? `<div class="data-note">Balances: ${Object.entries(balances).map(([name, value]) => `${esc(name)} ${esc(fmt(value))}`).join(' · ')}</div>` : ''}
  </div>`;
}

function sharedView(d) {
  return `${pageHead('Shared money', 'Groups, shared expenses and simplified settle-up suggestions.', `<button class="btn btn-primary" data-action="add-group">＋ New group</button>`)}
    <div class="manual-note" style="margin-bottom:18px"><span class="ic">✎</span><span>Shared expenses are <b>manually entered</b>. Payer, split method and amounts are recorded by you; settle-up suggestions are a simple guide, not a payment instruction.</span></div>
    ${d.groups.length ? `<div class="grid grid-2">${d.groups.map(g => groupCard(g, d)).join('')}</div>`
      : emptyState('⌁', 'No shared groups yet', 'Create a group with members, then add expenses with a payer and split method.', `<button class="btn btn-primary" data-action="add-group">Create a group</button>`)}`;
}

/* -------------------------------- details ------------------------------- */

function detailCard(item) {
  const color = item.type === 'date' ? '#d9ad63' : item.type === 'contact' ? '#2fb8ab'
    : item.type === 'document' ? '#5f8cff' : '#a78bfa';
  return `<div class="card detail-card">
    <div class="detail-top"><div><h3>${esc(item.title || 'Untitled record')}</h3>
      <div class="card-sub">${esc(item.type || 'note')}</div></div><span class="tag-pill" style="color:${color}">${esc(item.type || 'note')}</span></div>
    ${item.value ? `<div class="detail-value">${esc(item.value)}</div>` : ''}
    ${item.dueDate ? `<div><div class="tiny muted">Important date</div><div class="btn-row" style="margin-top:4px">${esc(dateLabel(item.dueDate, { short: true }))} ${daysBadge(item.dueDate)}</div></div>` : ''}
    ${item.notes ? `<p class="muted small">${esc(item.notes)}</p>` : ''}
    <div class="btn-row"><button class="btn btn-sm" data-action="edit-detail" data-id="${esc(item.id)}">Edit</button>
      <button class="btn btn-sm btn-danger" data-action="delete-detail" data-id="${esc(item.id)}">✕</button></div>
  </div>`;
}

function detailsView(d) {
  const f = state.filters.details;
  const rows = d.details.filter(x => f.type === 'all' || (x.type || 'note') === f.type)
    .sort((a, b) => String(a.dueDate || '9999').localeCompare(String(b.dueDate || '9999')));
  const dueSoon = d.details.filter(x => x.dueDate && daysUntil(x.dueDate) != null && daysUntil(x.dueDate) <= 14);
  return `${pageHead('Details / Records', 'Company details, important dates, contacts and policy, tax or insurance notes.', `<button class="btn btn-primary" data-action="add-detail">＋ Add record</button>`)}
    <div class="grid grid-3" style="margin-bottom:18px">
      <div class="card stat-card"><div class="stat-label">Company</div><div class="stat-value" style="font-size:22px">${esc(d.company.name || 'Not set')}</div><div class="stat-foot">${esc(d.company.industry || 'Industry not set')} · ${esc(d.company.size || 'Size not set')}</div></div>
      <div class="card stat-card"><div class="stat-label">EIN (manual)</div><div class="stat-value" style="font-size:22px">${esc(d.company.ein || '—')}</div><div class="stat-foot">Entered by you; never transmitted automatically</div></div>
      <div class="card stat-card"><div class="stat-label">Date alerts</div><div class="stat-value">${dueSoon.length}</div><div class="stat-foot">Due within 14 days or overdue</div></div>
    </div>
    <div class="card" style="margin-bottom:18px"><div class="filter-bar" style="grid-template-columns:minmax(220px,1fr) 200px">
      <div class="field" style="margin:0"><label>Records</label><p class="muted small">${rows.length} matching record${rows.length === 1 ? '' : 's'}</p></div>
      <div class="field"><label for="detail-type">Type</label><select class="input" id="detail-type"><option value="all">All types</option>${options(DETAIL_TYPES, f.type)}</select></div>
    </div></div>
    ${rows.length ? `<div class="grid grid-3" id="detail-list">${rows.map(detailCard).join('')}</div>`
      : emptyState('▦', 'No records yet', 'Add a company document, key date, contact or note.', `<button class="btn btn-primary" data-action="add-detail">Add a record</button>`)}`;
}

/* ------------------------------ retirement ------------------------------ */

function retirementView(d) {
  const ret = retirementTotals(d);
  return `${pageHead('Retirement', 'Plan rules, employee accounts and balances — all entered manually.', `<div class="btn-row">
    <button class="btn btn-primary" data-action="add-retirement-plan">＋ Add plan</button>
    <button class="btn" data-action="add-retirement-account">＋ Add account</button></div>`)}
    ${manualNote('<b>Retirement records are entered manually.</b> Atlas Business does not connect to payroll providers, plan custodians or banks. Add each plan, match formula and employee balance yourself, then update it when it changes.')}
    <div class="grid grid-4" style="margin-bottom:18px">
      <div class="card stat-card"><div class="stat-label">Total plan balance</div><div class="stat-value">${esc(fmt(ret.balance))}</div><div class="stat-foot">${ret.plans.length} plan${ret.plans.length === 1 ? '' : 's'} · ${ret.accounts.length} account${ret.accounts.length === 1 ? '' : 's'}</div></div>
      <div class="card stat-card"><div class="stat-label">Employer YTD</div><div class="stat-value up">${esc(fmt(ret.employerYTD))}</div><div class="stat-foot">Match and contributions</div></div>
      <div class="card stat-card"><div class="stat-label">Employee YTD</div><div class="stat-value up">${esc(fmt(ret.employeeYTD))}</div><div class="stat-foot">Deferrals and contributions</div></div>
      <div class="card stat-card"><div class="stat-label">Participation</div><div class="stat-value">${ret.participation}</div><div class="stat-foot">Active employee accounts</div></div>
    </div>

    <div class="card" style="margin-bottom:18px">
      <div class="card-head"><div><h3>Retirement plans</h3><div class="card-sub">Plan-level rules and recorded totals</div></div>
        <button class="btn btn-sm" data-action="add-retirement-plan">＋ Add plan</button></div>
      ${ret.plans.length ? `<div class="table-scroll"><table class="data"><thead><tr>
        <th>Plan</th><th>Type</th><th>Provider</th><th>Match formula</th><th>Vesting</th><th>Status</th>
        <th>Accounts</th><th>Balance</th><th>Employee YTD</th><th>Employer YTD</th><th>Actions</th></tr></thead><tbody>
        ${ret.plans.map(p => {
          const totals = retirementPlanTotals(p, d);
          const updated = p.updatedAt ? dateLabel(p.updatedAt, { short: true }) : '—';
          return `<tr>
            <td><div class="sym-cell"><span class="sym-logo" style="background:${esc(colorFor(p.name || 'P'))}">${esc((p.name || '?')[0].toUpperCase())}</span>
              <span><strong>${esc(p.name || 'Unnamed plan')}</strong><small>${esc(p.planNumber || 'No plan number')} · ${esc(updated)}</small></span></div></td>
            <td><span class="tag-pill">${esc(retirementLabel(p.type))}</span></td>
            <td class="muted">${esc(p.provider || '—')}</td>
            <td>${esc(p.employerMatchFormula || 'Not recorded')}</td>
            <td>${esc(p.vestingSchedule || 'Not recorded')}</td>
            <td>${retirementBadge(p.status, RETIREMENT_PLAN_STATUSES)}</td>
            <td>${totals.accounts.length}</td>
            <td>${esc(fmt(totals.balance))}</td>
            <td>${esc(fmt(totals.employeeYTD))}</td>
            <td>${esc(fmt(totals.employerYTD))}</td>
            <td><div class="row-actions"><button class="btn btn-sm" data-action="edit-retirement-plan" data-id="${esc(p.id)}">Edit</button>
              <button class="btn btn-sm btn-danger" data-action="delete-retirement-plan" data-id="${esc(p.id)}">✕</button></div></td>
          </tr>`;
        }).join('')}
      </tbody></table></div>` : emptyState('◴', 'No retirement plans yet', 'Add a 401(k), 403(b), IRA, HSA or pension plan with the match formula and vesting details you record yourself.', `<button class="btn btn-primary" data-action="add-retirement-plan">Add your first plan</button>`)}
    </div>

    <div class="card">
      <div class="card-head"><div><h3>Employee retirement accounts</h3><div class="card-sub">Balances and contributions are manual records</div></div>
        <button class="btn btn-sm" data-action="add-retirement-account">＋ Add account</button></div>
      ${ret.accounts.length ? `<div class="table-scroll"><table class="data"><thead><tr>
        <th>Employee</th><th>Plan</th><th>Balance</th><th>Employee YTD</th><th>Employer YTD</th>
        <th>Vested</th><th>Deferral</th><th>Status</th><th>Actions</th></tr></thead><tbody>
        ${ret.accounts.map(a => {
          const name = retirementEmployeeName(d, a.employeeId);
          const vested = Number(a.vestedPercent) || 0;
          const deferral = Number(a.deferralRate) || 0;
          const updated = a.updatedAt ? dateLabel(a.updatedAt, { short: true }) : '—';
          return `<tr>
            <td><div class="sym-cell"><span class="sym-logo" style="background:${esc(colorFor(name))}">${esc(initials(name))}</span>
              <span><strong>${esc(name)}</strong><small>${esc(a.name || 'Retirement account')} · ${esc(updated)}</small></span></div></td>
            <td>${esc(retirementPlanName(d, a.planId))}</td>
            <td>${esc(fmt(a.balance))}</td>
            <td>${esc(fmt(a.employeeYTD))}</td>
            <td>${esc(fmt(a.employerYTD))}</td>
            <td>${vested.toFixed(1)}%</td>
            <td>${deferral.toFixed(1)}%</td>
            <td>${retirementBadge(a.status, RETIREMENT_ACCOUNT_STATUSES)}</td>
            <td><div class="row-actions"><button class="btn btn-sm" data-action="edit-retirement-account" data-id="${esc(a.id)}">Edit</button>
              <button class="btn btn-sm btn-danger" data-action="delete-retirement-account" data-id="${esc(a.id)}">✕</button></div></td>
          </tr>`;
        }).join('')}
      </tbody></table></div>` : emptyState('♙', 'No employee retirement accounts yet', 'Add balances and year-to-date contributions by hand. If a person record is removed, the account stays visible as “Former employee”.', `<button class="btn btn-primary" data-action="add-retirement-account">Add an account</button>`)}
    </div>`;
}

/* ------------------------------- insights ------------------------------- */

function insightsView(d) {
  const m = insightsFor(d);
  const runway = runwayMonths(d);
  const series = cashflowSeries(d);
  const suggest = (icon, title, value, copy) => `<div class="card"><div class="insight"><span class="ic">${icon}</span><div><strong>${esc(title)}</strong><p>${copy}</p></div></div>
    <div class="hero-value" style="font-size:28px;margin-top:14px">${esc(value)}</div></div>`;
  return `${pageHead('Insights', 'Deterministic analysis from your own records. No AI provider, no external scoring.')}
    <div class="grid grid-3" style="margin-bottom:18px">
      ${suggest('◈', 'Largest expense category', m.spend[0] ? esc(m.spend[0].label) : '—', m.spend[0]
        ? `This month: <b>${esc(fmt(m.spend[0].value))}</b> across manually entered transactions.` : 'Add expense transactions to see your categories.')}
      ${suggest('♙', 'Payroll as % of outflow', m.burn > 0 ? `${m.payrollShare.toFixed(1)}%` : '—', `Estimated monthly payroll of <b>${esc(fmt(monthlyPayroll(d)))}</b> against <b>${esc(fmt(m.burn))}</b> total outflow.`)}
      ${suggest('◇', 'Debt to monthly cashflow', d.transactions.length ? `${m.debtRatio.toFixed(2)}×` : '—', `Total debt <b>${esc(fmt(totalDebt(d)))}</b> versus average monthly cashflow <b>${esc(fmt(m.cashflow))}</b>.`).replace('<b>$', '<b>$')}
      ${suggest('▧', 'Top receivable client', m.topClient ? esc(m.topClient[0]) : '—', m.topClient ? `Outstanding: <b>${esc(fmt(m.topClient[1]))}</b>.` : 'Add an unpaid invoice to see your top client.')}
      ${suggest('⌁', 'Busiest shared group', m.busiest ? esc(m.busiest.name) : '—', m.busiest ? `${d.sharedExpenses.filter(x => x.groupId === m.busiest.id).length} shared expenses recorded.` : 'Create a shared group and add expenses.')}
      ${suggest('◷', 'Next important date', m.next ? esc(m.next.title) : '—', m.next ? `${esc(dateLabel(m.next.date, { short: true }))} · ${esc(m.next.kind)}${m.next.amount ? ` · ${esc(fmt(m.next.amount))}` : ''}` : 'No debt, invoice or record dates coming up.')}
    </div>
    <div class="grid grid-2" style="margin-bottom:18px">
      ${suggest('◴', 'Retirement participation', `${m.retirement.participation}`, `${m.retirement.plans.length} plan${m.retirement.plans.length === 1 ? '' : 's'} and <b>${m.retirement.accounts.length}</b> manual account${m.retirement.accounts.length === 1 ? '' : 's'} recorded.`)}
      ${suggest('↗', 'Employer retirement contributions', fmt(m.retirement.employerYTD, 0), `Year-to-date match and profit sharing across <b>${esc(fmt(m.retirement.balance, 0))}</b> of recorded balances.`)}
    </div>
    <div class="grid grid-main">
      <div class="card"><div class="card-head"><div><h3>Cashflow trend</h3><div class="card-sub">Six-month view from manual transactions</div></div></div>
        ${lineChart(series.map(p => ({ ...p, date: p.label })), { currency: currency(), height: 240, color: '#2fb8ab', label: 'Cashflow trend' })}
      </div>
      <div class="stack">
        <div class="card"><div class="card-head"><h3>Category mix</h3><span class="tag-pill">This month</span></div>
          ${bars(m.spend.slice(0, 7).map(s => ({ ...s, display: fmt(s.value, 0) })))}</div>
        <div class="card"><div class="card-head"><h3>Other signals</h3></div>
          <div class="kv-list">
            <div class="kv"><span>Cash runway estimate</span><b>${runway == null ? '—' : `${num(runway, 1)} months`}</b></div>
            <div class="kv"><span>Top vendor by spend</span><b>${m.topVendor ? esc(m.topVendor[0]) : '—'}</b></div>
            <div class="kv"><span>Monthly debt service</span><b>${esc(fmt(monthlyDebtService(d)))}</b></div>
            <div class="kv"><span>Outstanding receivables</span><b>${esc(fmt(outstandingReceivables(d)))}</b></div>
            <div class="kv"><span>Investment snapshot</span><b>${d.investments ? esc(fmt(investmentValue(d))) : 'Not linked'}</b></div>
          </div>
          <div class="data-note">All figures are calculated locally from manually entered records.</div>
        </div>
      </div>
    </div>`;
}

/* ------------------------------ connections ------------------------------ */

function connectionsView(d) {
  const cloud = store.authMode() === 'cloud';
  const healthText = state.cloud.phase === 'online' ? 'Reachable' : state.cloud.phase === 'checking' ? 'Checking…' : 'Unavailable';
  const lastSync = state.cloud.lastSync || store.getSyncMeta().lastSync;
  const linked = !!d.investments && d.settings.linkedMeridian;
  const m = meridianParts(d);
  return `${pageHead('Connections', 'Optional cloud sync and a read-only Meridian import. No bank or payroll connections.')}
    <div class="grid grid-2">
      <div class="card">
        <div class="card-head"><div><h3>Atlas Sync endpoint</h3><div class="card-sub">Base URL for cloud snapshots and live events</div></div>
          <span class="badge ${state.cloud.phase === 'online' ? 'live' : 'warn'}" data-sync-badge>${esc(healthText)}</span></div>
        <form id="endpoint-form"><div class="field"><label for="sync-endpoint-input">Endpoint</label>
          <input class="input" id="sync-endpoint-input" name="endpoint" value="${esc(store.getSyncEndpoint())}" placeholder="https://atlas-sync.greenhenry441.workers.dev"/></div>
          <button class="btn btn-primary" type="submit">Save & check endpoint</button></form>
        <div class="sync-grid" style="margin-top:18px">
          <div class="sync-row"><span>Sync service</span><b>${esc(healthText)}</b></div>
          <div class="sync-row"><span>Account mode</span><b>${cloud ? 'Cloud' : 'Browser / local'}</b></div>
          <div class="sync-row"><span>Live status</span><b data-sync-status>${esc(statusInfo().text)}</b></div>
          <div class="sync-row"><span>Last sync</span><b data-sync-time>${lastSync ? esc(dateLabel(lastSync, { relative: true })) : 'Not synced yet'}</b></div>
          <div class="sync-row"><span>Client ID</span><b class="tiny">${esc(store.clientId())}</b></div>
        </div>
        ${!cloud ? `<p class="muted small" style="margin-top:14px">Cloud sign-in is available on the <a href="${ROUTES.signin}" style="color:var(--accent-2);font-weight:700">sign-in page</a> when the endpoint is reachable.</p>` : ''}
      </div>
      <div class="card meridian-card">
        <div class="card-head"><div><h3>Meridian Connector</h3><div class="card-sub">Read-only investing snapshot</div></div>
          <span class="badge ${linked ? 'live' : 'neutral'}">${linked ? 'Linked' : 'Not linked'}</span></div>
        <p class="muted small">Redeem a pairing code from Meridian to import holdings. No Meridian password is requested or stored.</p>
        <form id="meridian-form" style="margin-top:18px">
          <div class="field"><label for="meridian-code">Six-digit pairing code</label>
            <input class="input" id="meridian-code" name="code" inputmode="numeric" maxlength="12" placeholder="123456" autocomplete="off"/></div>
          <div class="form-error" id="meridian-error"></div>
          <button class="btn btn-primary" type="submit" ${state.connectorBusy ? 'disabled' : ''}>${state.connectorBusy ? 'Connecting…' : 'Redeem & import →'}</button>
        </form>
        <div class="sync-grid" style="margin-top:18px">
          <div class="sync-row"><span>Linked snapshot</span><b>${linked ? `${m.holdings.length} holdings` : 'None'}</b></div>
          <div class="sync-row"><span>Snapshot saved</span><b>${linked ? esc(dateLabel(m.updatedAt || Date.now(), { short: true })) : '—'}</b></div>
        </div>
        ${linked ? `<button class="btn btn-sm btn-danger" style="margin-top:16px" data-action="unlink-meridian">Unlink snapshot</button>` : ''}
        ${manualNote('The imported snapshot is <b>read-only</b>. Meridian holdings cannot be edited here, and the import never asks for a Meridian password.')}
      </div>
    </div>`;
}

/* -------------------------------- settings -------------------------------- */

function settingsView(d) {
  const user = store.currentUser() || {};
  return `${pageHead('Settings', 'Company preferences, data controls and account access.')}
    <div class="grid grid-2">
      <div class="card">
        <div class="card-head"><h3>Company details</h3><span class="tag-pill">Manual</span></div>
        <form id="company-form">
          <div class="field"><label for="company-name">Company name</label><input class="input" id="company-name" name="name" value="${esc(d.company.name || '')}" placeholder="Northstar Studio"/></div>
          <div class="form-grid">
            <div class="field"><label for="company-industry">Industry</label><input class="input" id="company-industry" name="industry" value="${esc(d.company.industry || '')}" placeholder="Design services"/></div>
            <div class="field"><label for="company-size">Team size</label><input class="input" id="company-size" name="size" value="${esc(d.company.size || '')}" placeholder="1–10"/></div>
          </div>
          <div class="field"><label for="company-ein">EIN / tax ID (manual)</label><input class="input" id="company-ein" name="ein" value="${esc(d.company.ein || '')}" placeholder="XX-XXXXXXX"/></div>
          <button class="btn btn-primary" type="submit">Save company details</button>
        </form>
      </div>
      <div class="card">
        <div class="card-head"><h3>Preferences</h3></div>
        <div class="field"><label for="theme-select">Theme</label><select class="input" id="theme-select">
          <option value="ink" ${selected('ink', store.getPrefs().theme)}>Ink — deep navy</option>
          <option value="paper" ${selected('paper', store.getPrefs().theme)}>Paper — warm light</option></select></div>
        <div class="field"><label for="currency-select">Currency</label><select class="input" id="currency-select">${options(CURRENCIES, store.getPrefs().currency)}</select></div>
        <form id="settings-endpoint-form" style="margin-top:14px">
          <div class="field"><label for="settings-endpoint-input">Sync endpoint</label>
            <input class="input" id="settings-endpoint-input" value="${esc(store.getSyncEndpoint())}"/></div>
          <button class="btn" type="submit">Save endpoint</button>
        </form>
      </div>
      <div class="card">
        <div class="card-head"><h3>Data tools</h3><span class="tag-pill">Local first</span></div>
        <p class="muted small">Export a JSON copy of everything you entered, including retirement plans and accounts, import a backup, or clear this workspace. Tokens are never included in an export.</p>
        <div class="btn-row" style="margin-top:16px">
          <button class="btn btn-primary btn-sm" data-action="export-data">⬇ Export JSON</button>
          <button class="btn btn-sm" data-action="import-data">⬆ Import JSON</button>
          <button class="btn btn-danger btn-sm" data-action="clear-data">Clear all data</button>
        </div>
        <div class="sync-grid" style="margin-top:18px">
          <div class="sync-row"><span>Signed in as</span><b>${esc(user.name || user.email || 'Local user')}</b></div>
          <div class="sync-row"><span>Account mode</span><b>${store.authMode() === 'cloud' ? 'Cloud' : 'Browser / local'}</b></div>
          <div class="sync-row"><span>Onboarding</span><b>${store.getPrefs().onboardingComplete ? 'Complete' : 'Pending'}</b></div>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h3>Account access</h3></div>
        <p class="muted small">${store.authMode() === 'cloud'
          ? 'Cloud sign-out stops live sync and removes the local bearer token. Your manually entered data stays in this browser.'
          : 'This is a browser-only account. Credentials are salted and hashed with PBKDF2 in this browser.'}</p>
        <div class="btn-row" style="margin-top:16px">
          ${store.authMode() === 'cloud' ? `<button class="btn btn-sm" data-action="cloud-signout">Sign out of cloud</button>` : ''}
          <button class="btn btn-danger btn-sm" data-action="delete-profile">Delete this account</button>
        </div>
        <div class="data-note">${esc(BRAND.dba)} is a product of ${esc(BRAND.legal)}. Manual bank, payroll and tax data only.</div>
      </div>
    </div>`;
}

/* --------------------------------- modals --------------------------------- */

function employeeModal(id) {
  const e = store.data().employees.find(x => x.id === id) || {};
  openModal(`${modalHead(id ? 'Edit employee' : 'Add employee', 'All pay details are entered manually.')}
    <form id="employee-form"><input type="hidden" name="id" value="${esc(e.id || '')}"/>
      <div class="form-grid">
        <div class="field"><label for="emp-name">Full name</label><input class="input" id="emp-name" name="name" value="${esc(e.name || '')}" required/></div>
        <div class="field"><label for="emp-email">Email</label><input class="input" id="emp-email" name="email" type="email" value="${esc(e.email || '')}"/></div>
        <div class="field"><label for="emp-role">Role</label><input class="input" id="emp-role" name="role" value="${esc(e.role || '')}" placeholder="Operations lead"/></div>
        <div class="field"><label for="emp-department">Department</label><input class="input" id="emp-department-name" name="department" value="${esc(e.department || '')}" placeholder="Operations"/></div>
        <div class="field"><label for="emp-paytype">Pay type</label><select class="input" id="emp-paytype" name="payType">${options(PAY_TYPES, e.payType || 'salary')}</select></div>
        <div class="field"><label for="emp-rate">Rate (annual salary or hourly rate)</label><input class="input" id="emp-rate" name="rate" type="number" min="0" step="0.01" value="${esc(e.rate ?? 0)}"/></div>
        <div class="field"><label for="emp-frequency">Pay frequency</label><select class="input" id="emp-frequency" name="payFrequency">${options(PAY_FREQUENCIES, e.payFrequency || 'biweekly')}</select></div>
        <div class="field"><label for="emp-start">Start date</label><input class="input" id="emp-start" name="startDate" type="date" value="${esc(e.startDate || dateInput())}"/></div>
        <div class="field"><label for="emp-status">Status</label><select class="input" id="emp-status-form" name="status">${options(EMPLOYEE_STATUSES, e.status || 'active')}</select></div>
      </div>
      <div class="form-error" id="employee-error"></div>
      <div class="modal-actions"><button type="button" class="btn" data-action="modal-close">Cancel</button><button class="btn btn-primary" type="submit">Save employee</button></div>
    </form>`);
}

function payrollModal(id) {
  const r = store.data().payroll.find(x => x.id === id) || {};
  openModal(`${modalHead(id ? 'Edit pay period' : 'New pay period', 'Gross items are generated from active employees and can be edited.')}
    <form id="payroll-form"><input type="hidden" name="id" value="${esc(r.id || '')}"/>
      <div class="form-grid">
        <div class="field"><label for="pay-start">Period start</label><input class="input" id="pay-start" name="periodStart" type="date" value="${esc(r.periodStart || dateInput())}"/></div>
        <div class="field"><label for="pay-end">Period end</label><input class="input" id="pay-end" name="periodEnd" type="date" value="${esc(r.periodEnd || dateInput(addDays(new Date(), 13)))}"/></div>
        <div class="field"><label for="pay-date">Pay date</label><input class="input" id="pay-date" name="payDate" type="date" value="${esc(r.payDate || dateInput(addDays(new Date(), 17)))}"/></div>
        <div class="field"><label for="pay-status">Status</label><select class="input" id="pay-status" name="status">${options(PAYROLL_STATUSES, r.status || 'draft')}</select></div>
      </div>
      <div class="field"><label for="pay-notes">Notes (optional)</label><textarea class="input" id="pay-notes" name="notes">${esc(r.notes || '')}</textarea></div>
      <div class="form-error" id="payroll-error"></div>
      <div class="modal-actions"><button type="button" class="btn" data-action="modal-close">Cancel</button><button class="btn btn-primary" type="submit">Save period</button></div>
    </form>`);
}

function payrollItemModal(runId, employeeId) {
  const d = store.data();
  const run = d.payroll.find(r => r.id === runId);
  const item = run?.items.find(i => i.employeeId === employeeId) || {};
  const emp = d.employees.find(e => e.id === employeeId) || {};
  openModal(`${modalHead(`Pay · ${emp.name || 'Employee'}`, 'Edit gross, deductions, taxes and net manually.')}
    <form id="payroll-item-form"><input type="hidden" name="runId" value="${esc(runId)}"/><input type="hidden" name="employeeId" value="${esc(employeeId)}"/>
      <div class="form-grid">
        <div class="field"><label for="pi-gross">Gross</label><input class="input" id="pi-gross" name="gross" type="number" step="0.01" value="${esc(item.gross ?? 0)}"/></div>
        <div class="field"><label for="pi-deductions">Deductions</label><input class="input" id="pi-deductions" name="deductions" type="number" step="0.01" value="${esc(item.deductions ?? 0)}"/></div>
        <div class="field"><label for="pi-taxes">Taxes</label><input class="input" id="pi-taxes" name="taxes" type="number" step="0.01" value="${esc(item.taxes ?? 0)}"/></div>
        <div class="field"><label for="pi-net">Net</label><input class="input" id="pi-net" name="net" type="number" step="0.01" value="${esc(item.net ?? 0)}"/></div>
      </div>
      <button type="button" class="btn btn-sm" data-action="recalc-net">Recalculate net from gross − deductions − taxes</button>
      <div class="form-error" id="payroll-item-error"></div>
      <div class="modal-actions"><button type="button" class="btn" data-action="modal-close">Cancel</button><button class="btn btn-primary" type="submit">Save pay item</button></div>
    </form>`);
}

function debtModal(id) {
  const debt = store.data().debts.find(x => x.id === id) || {};
  openModal(`${modalHead(id ? 'Edit debt' : 'Add debt', 'Balance, rate and payment details are entered manually.')}
    <form id="debt-form"><input type="hidden" name="id" value="${esc(debt.id || '')}"/>
      <div class="form-grid">
        <div class="field"><label for="debt-name">Name</label><input class="input" id="debt-name" name="name" value="${esc(debt.name || '')}" placeholder="Equipment loan" required/></div>
        <div class="field"><label for="debt-creditor">Creditor</label><input class="input" id="debt-creditor" name="creditor" value="${esc(debt.creditor || '')}"/></div>
        <div class="field"><label for="debt-type">Type</label><select class="input" id="debt-type" name="type">${options(DEBT_TYPES, debt.type || 'loan')}</select></div>
        <div class="field"><label for="debt-priority">Priority</label><select class="input" id="debt-priority" name="priority">${options(DEBT_PRIORITIES, debt.priority || 'medium')}</select></div>
        <div class="field"><label for="debt-original">Original amount</label><input class="input" id="debt-original" name="original" type="number" min="0" step="0.01" value="${esc(debt.original ?? 0)}"/></div>
        <div class="field"><label for="debt-balance">Current balance</label><input class="input" id="debt-balance" name="balance" type="number" min="0" step="0.01" value="${esc(debt.balance ?? 0)}"/></div>
        <div class="field"><label for="debt-rate">Interest rate (APR %)</label><input class="input" id="debt-rate" name="rate" type="number" min="0" step="0.01" value="${esc(debt.rate ?? 0)}"/></div>
        <div class="field"><label for="debt-min">Minimum payment / month</label><input class="input" id="debt-min" name="minimumPayment" type="number" min="0" step="0.01" value="${esc(debt.minimumPayment ?? 0)}"/></div>
        <div class="field"><label for="debt-due">Due date</label><input class="input" id="debt-due" name="dueDate" type="date" value="${esc(debt.dueDate || '')}"/></div>
      </div>
      <div class="field"><label for="debt-notes">Notes</label><textarea class="input" id="debt-notes" name="notes">${esc(debt.notes || '')}</textarea></div>
      <div class="form-error" id="debt-error"></div>
      <div class="modal-actions"><button type="button" class="btn" data-action="modal-close">Cancel</button><button class="btn btn-primary" type="submit">Save debt</button></div>
    </form>`);
}

function debtPaymentModal(debtId) {
  const d = store.data();
  const debt = d.debts.find(x => x.id === debtId);
  openModal(`${modalHead('Record debt payment', debt ? `Payment against ${debt.name}` : 'Debt')}
    <form id="debt-payment-form"><input type="hidden" name="debtId" value="${esc(debtId)}"/>
      <div class="form-grid">
        <div class="field"><label for="dp-date">Date</label><input class="input" id="dp-date" name="date" type="date" value="${esc(dateInput())}"/></div>
        <div class="field"><label for="dp-amount">Amount</label><input class="input" id="dp-amount" name="amount" type="number" min="0.01" step="0.01" required/></div>
      </div>
      <div class="field"><label for="dp-note">Note</label><input class="input" id="dp-note" name="note" placeholder="Monthly payment"/></div>
      <label class="checkrow" style="margin-bottom:12px"><input type="checkbox" name="reduceBalance" checked/> Also reduce the recorded balance by this amount</label>
      <div class="form-error" id="debt-payment-error"></div>
      <div class="modal-actions"><button type="button" class="btn" data-action="modal-close">Cancel</button><button class="btn btn-primary" type="submit">Record payment</button></div>
    </form>`);
}

function accountModal(id) {
  const a = store.data().accounts.find(x => x.id === id) || {};
  openModal(`${modalHead(id ? 'Edit account' : 'Add account', 'Manual balance — no bank login or aggregation.')}
    <form id="account-form"><input type="hidden" name="id" value="${esc(a.id || '')}"/>
      <div class="form-grid">
        <div class="field"><label for="acc-name">Account name</label><input class="input" id="acc-name" name="name" value="${esc(a.name || '')}" placeholder="Operating checking" required/></div>
        <div class="field"><label for="acc-institution">Institution</label><input class="input" id="acc-institution" name="institution" value="${esc(a.institution || 'Manual entry')}"/></div>
        <div class="field"><label for="acc-type">Type</label><select class="input" id="acc-type" name="type">${options(ACCOUNT_TYPES, a.type || 'Operating')}</select></div>
        <div class="field"><label for="acc-mask">Last digits (optional)</label><input class="input" id="acc-mask" name="mask" value="${esc(a.mask || '')}"/></div>
        <div class="field"><label for="acc-balance">Current balance</label><input class="input" id="acc-balance" name="balance" type="number" step="0.01" value="${esc(a.balance ?? 0)}"/></div>
        <div class="field"><label for="acc-color">Color</label><select class="input" id="acc-color" name="color">${ACCOUNT_COLORS.map(c => `<option value="${c}" ${selected(c, a.color || ACCOUNT_COLORS[0])}>${c}</option>`).join('')}</select></div>
      </div>
      <div class="form-error" id="account-error"></div>
      <div class="modal-actions"><button type="button" class="btn" data-action="modal-close">Cancel</button><button class="btn btn-primary" type="submit">Save account</button></div>
    </form>`);
}

function transactionModal(id) {
  const d = store.data();
  const t = d.transactions.find(x => x.id === id) || {};
  openModal(`${modalHead(id ? 'Edit transaction' : 'Add transaction', 'Recorded manually against one of your accounts.')}
    <form id="transaction-form"><input type="hidden" name="id" value="${esc(t.id || '')}"/>
      <div class="form-grid">
        <div class="field"><label for="tx-description">Description</label><input class="input" id="tx-description" name="description" value="${esc(t.description || '')}" placeholder="Monthly software bill" required/></div>
        <div class="field"><label for="tx-date">Date</label><input class="input" id="tx-date" name="date" type="date" value="${esc(t.date || dateInput())}"/></div>
        <div class="field"><label for="tx-amount">Amount</label><input class="input" id="tx-amount" name="amount" type="number" min="0" step="0.01" value="${esc(t.amount ?? 0)}"/></div>
        <div class="field"><label for="tx-type-form">Type</label><select class="input" id="tx-type-form" name="type">${options(TRANSACTION_TYPES, t.type || 'expense')}</select></div>
        <div class="field"><label for="tx-account-form">Account</label><select class="input" id="tx-account-form" name="accountId"><option value="">Unassigned</option>${d.accounts.map(a => `<option value="${esc(a.id)}" ${selected(a.id, t.accountId)}>${esc(a.name)}</option>`).join('')}</select></div>
        <div class="field"><label for="tx-category-form">Category</label><select class="input" id="tx-category-form" name="category">${options(CATEGORIES, t.category || 'Other')}</select></div>
      </div>
      <div class="form-error" id="transaction-error"></div>
      <div class="modal-actions"><button type="button" class="btn" data-action="modal-close">Cancel</button><button class="btn btn-primary" type="submit">Save transaction</button></div>
    </form>`);
}

function budgetModal(id) {
  const b = store.data().budgets.find(x => x.id === id) || {};
  openModal(`${modalHead(id ? 'Edit budget' : 'New budget', 'Limits are calculated from manual expense transactions.')}
    <form id="budget-form"><input type="hidden" name="id" value="${esc(b.id || '')}"/>
      <div class="form-grid">
        <div class="field"><label for="budget-category">Category</label><select class="input" id="budget-category" name="category">${options(EXPENSE_CATEGORIES, b.category || 'Software')}</select></div>
        <div class="field"><label for="budget-limit">Limit</label><input class="input" id="budget-limit" name="limit" type="number" min="0" step="0.01" value="${esc(b.limit ?? 300)}"/></div>
        <div class="field"><label for="budget-period">Period</label><select class="input" id="budget-period" name="period">${options(BUDGET_PERIODS, b.period || 'monthly')}</select></div>
      </div>
      <div class="form-error" id="budget-error"></div>
      <div class="modal-actions"><button type="button" class="btn" data-action="modal-close">Cancel</button><button class="btn btn-primary" type="submit">Save budget</button></div>
    </form>`);
}

function invoiceModal(id) {
  const i = store.data().invoices.find(x => x.id === id) || {};
  openModal(`${modalHead(id ? 'Edit invoice' : 'New invoice', 'Amounts and dates are entered manually.')}
    <form id="invoice-form"><input type="hidden" name="id" value="${esc(i.id || '')}"/>
      <div class="form-grid">
        <div class="field"><label for="inv-client">Client</label><input class="input" id="inv-client" name="client" value="${esc(i.client || '')}" placeholder="Acme Co." required/></div>
        <div class="field"><label for="inv-amount">Amount</label><input class="input" id="inv-amount" name="amount" type="number" min="0" step="0.01" value="${esc(i.amount ?? 0)}"/></div>
        <div class="field"><label for="inv-issue">Issue date</label><input class="input" id="inv-issue" name="issueDate" type="date" value="${esc(i.issueDate || dateInput())}"/></div>
        <div class="field"><label for="inv-due">Due date</label><input class="input" id="inv-due" name="dueDate" type="date" value="${esc(i.dueDate || dateInput(addDays(new Date(), 30)))}"/></div>
        <div class="field"><label for="inv-status">Status</label><select class="input" id="inv-status" name="status">${options(INVOICE_STATUSES, i.status || 'draft')}</select></div>
      </div>
      <div class="field"><label for="inv-notes">Notes</label><textarea class="input" id="inv-notes" name="notes">${esc(i.notes || '')}</textarea></div>
      <div class="form-error" id="invoice-error"></div>
      <div class="modal-actions"><button type="button" class="btn" data-action="modal-close">Cancel</button><button class="btn btn-primary" type="submit">Save invoice</button></div>
    </form>`);
}

function expenseModal(id) {
  const d = store.data();
  const e = d.expenses.find(x => x.id === id) || {};
  openModal(`${modalHead(id ? 'Edit expense' : 'Add expense', 'Vendor expenses are entered manually.')}
    <form id="expense-form"><input type="hidden" name="id" value="${esc(e.id || '')}"/>
      <div class="form-grid">
        <div class="field"><label for="exp-vendor">Vendor</label><input class="input" id="exp-vendor" name="vendor" value="${esc(e.vendor || '')}" placeholder="Office supply co." required/></div>
        <div class="field"><label for="exp-date">Date</label><input class="input" id="exp-date" name="date" type="date" value="${esc(e.date || dateInput())}"/></div>
        <div class="field"><label for="exp-amount">Amount</label><input class="input" id="exp-amount" name="amount" type="number" min="0" step="0.01" value="${esc(e.amount ?? 0)}"/></div>
        <div class="field"><label for="exp-category">Category</label><select class="input" id="exp-category" name="category">${options(EXPENSE_CATEGORIES, e.category || 'Supplies')}</select></div>
        <div class="field"><label for="exp-status">Status</label><select class="input" id="exp-status-form" name="status">${options(EXPENSE_STATUSES, e.status || 'pending')}</select></div>
        <div class="field"><label for="exp-account">Paid from</label><select class="input" id="exp-account" name="accountId"><option value="">Unassigned</option>${d.accounts.map(a => `<option value="${esc(a.id)}" ${selected(a.id, e.accountId)}>${esc(a.name)}</option>`).join('')}</select></div>
      </div>
      <div class="field"><label for="exp-notes">Notes</label><textarea class="input" id="exp-notes" name="notes">${esc(e.notes || '')}</textarea></div>
      <div class="form-error" id="expense-error"></div>
      <div class="modal-actions"><button type="button" class="btn" data-action="modal-close">Cancel</button><button class="btn btn-primary" type="submit">Save expense</button></div>
    </form>`);
}

function groupModal(id) {
  const g = store.data().groups.find(x => x.id === id) || {};
  openModal(`${modalHead(id ? 'Edit group' : 'New group', 'Enter one member name per line.')}
    <form id="group-form"><input type="hidden" name="id" value="${esc(g.id || '')}"/>
      <div class="field"><label for="group-name">Group name</label><input class="input" id="group-name" name="name" value="${esc(g.name || '')}" placeholder="Team trip" required/></div>
      <div class="field"><label for="group-members">Members (one per line)</label>
        <textarea class="input" id="group-members" name="members" rows="5" placeholder="Jordan Lee&#10;Sam Rivera">${esc(groupMembers(g).map(m => m.name).join('\n'))}</textarea></div>
      <div class="form-error" id="group-error"></div>
      <div class="modal-actions"><button type="button" class="btn" data-action="modal-close">Cancel</button><button class="btn btn-primary" type="submit">Save group</button></div>
    </form>`);
}

function sharedExpenseModal(groupId) {
  const d = store.data();
  const g = d.groups.find(x => x.id === groupId);
  if (!g) { toast('Create a group first.', 'error'); return; }
  const members = groupMembers(g);
  openModal(`${modalHead('Add shared expense', 'Custom shares must add up to the total amount.')}
    <form id="shared-expense-form"><input type="hidden" name="groupId" value="${esc(groupId)}"/>
      <div class="form-grid">
        <div class="field"><label for="se-title">Title</label><input class="input" id="se-title" name="title" placeholder="Dinner" required/></div>
        <div class="field"><label for="se-amount">Total amount</label><input class="input" id="se-amount" name="amount" type="number" min="0.01" step="0.01" required/></div>
        <div class="field"><label for="se-date">Date</label><input class="input" id="se-date" name="date" type="date" value="${esc(dateInput())}"/></div>
        <div class="field"><label for="se-payer">Payer</label><select class="input" id="se-payer" name="payerId">${members.map(m => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('')}</select></div>
        <div class="field"><label for="se-split">Split method</label><select class="input" id="se-split" name="split">${options(SPLIT_METHODS, 'equal')}</select></div>
        <div class="field"><label for="se-category">Category</label><select class="input" id="se-category" name="category">${options(EXPENSE_CATEGORIES, 'Meals')}</select></div>
      </div>
      <div id="split-fields" class="notice">Equal split: the total is divided evenly between ${members.length} member${members.length === 1 ? '' : 's'}.</div>
      <div class="field" style="margin-top:14px"><label for="se-note">Note</label><input class="input" id="se-note" name="note"/></div>
      <div class="form-error" id="shared-expense-error"></div>
      <div class="modal-actions"><button type="button" class="btn" data-action="modal-close">Cancel</button><button class="btn btn-primary" type="submit">Save expense</button></div>
    </form>`);
  const splitEl = $('#se-split');
  if (splitEl) splitEl.addEventListener('change', () => {
    const method = splitEl.value;
    const host = $('#split-fields');
    if (!host) return;
    if (method === 'equal') { host.className = 'notice'; host.textContent = `Equal split: the total is divided evenly between ${members.length} member${members.length === 1 ? '' : 's'}.`; return; }
    host.className = 'card';
    host.innerHTML = `<div class="card-head"><h3 style="font-size:14px">${method === 'shares' ? 'Shares per member' : 'Custom amounts per member'}</h3></div>
      ${members.map(m => `<div class="split-row"><span>${esc(m.name)}</span>
        <input class="input" type="number" min="0" step="${method === 'shares' ? '1' : '0.01'}" name="${method}_${esc(m.id)}" placeholder="${method === 'shares' ? '1' : '0.00'}"/>
        <span class="tiny muted">${method === 'shares' ? 'shares' : 'amount'}</span></div>`).join('')}`;
  });
}

function detailModal(id) {
  const item = store.data().details.find(x => x.id === id) || {};
  openModal(`${modalHead(id ? 'Edit record' : 'Add record', 'Company details, dates, contacts and notes.')}
    <form id="detail-form"><input type="hidden" name="id" value="${esc(item.id || '')}"/>
      <div class="form-grid">
        <div class="field"><label for="detail-title">Title</label><input class="input" id="detail-title" name="title" value="${esc(item.title || '')}" placeholder="Li insurance renewal" required/></div>
        <div class="field"><label for="detail-type-form">Type</label><select class="input" id="detail-type-form" name="type">${options(DETAIL_TYPES, item.type || 'note')}</select></div>
        <div class="field"><label for="detail-value">Value / reference</label><input class="input" id="detail-value" name="value" value="${esc(item.value || '')}" placeholder="Policy number or contact details"/></div>
        <div class="field"><label for="detail-due">Important date</label><input class="input" id="detail-due" name="dueDate" type="date" value="${esc(item.dueDate || '')}"/></div>
      </div>
      <div class="field"><label for="detail-notes">Notes</label><textarea class="input" id="detail-notes" name="notes">${esc(item.notes || '')}</textarea></div>
      <div class="form-error" id="detail-error"></div>
      <div class="modal-actions"><button type="button" class="btn" data-action="modal-close">Cancel</button><button class="btn btn-primary" type="submit">Save record</button></div>
    </form>`);
}

function retirementPlanModal(id) {
  const p = store.data().retirementPlans.find(x => x.id === id) || {};
  openModal(`${modalHead(p.id ? 'Edit retirement plan' : 'Add a retirement plan', 'Plan rules and contribution totals are entered manually.')}
    <form id="retirement-plan-form"><input type="hidden" name="id" value="${esc(p.id || '')}"/>
      <div class="form-grid">
        <div class="field"><label for="rp-name">Plan name</label><input class="input" id="rp-name" name="name" value="${esc(p.name || '')}" placeholder="Employer 401(k)" required/></div>
        <div class="field"><label for="rp-type">Type</label><select class="input" id="rp-type" name="type">${RETIREMENT_TYPES.map(t => `<option value="${esc(t.value)}" ${selected(t.value, p.type || '401k')}>${esc(t.label)}</option>`).join('')}</select></div>
        <div class="field"><label for="rp-provider">Provider / custodian</label><input class="input" id="rp-provider" name="provider" value="${esc(p.provider || '')}" placeholder="Plan administrator"/></div>
        <div class="field"><label for="rp-number">Plan number</label><input class="input" id="rp-number" name="planNumber" value="${esc(p.planNumber || '')}" placeholder="Optional"/></div>
        <div class="field"><label for="rp-match">Employer match formula</label><input class="input" id="rp-match" name="employerMatchFormula" value="${esc(p.employerMatchFormula || '')}" placeholder="50% of first 6%"/></div>
        <div class="field"><label for="rp-vesting">Vesting schedule</label><input class="input" id="rp-vesting" name="vestingSchedule" value="${esc(p.vestingSchedule || '')}" placeholder="3-year cliff"/></div>
        <div class="field"><label for="rp-eligibility">Eligibility</label><input class="input" id="rp-eligibility" name="eligibility" value="${esc(p.eligibility || '')}" placeholder="All full-time employees"/></div>
        <div class="field"><label for="rp-status">Status</label><select class="input" id="rp-status" name="status">${RETIREMENT_PLAN_STATUSES.map(s => `<option value="${esc(s.value)}" ${selected(s.value, p.status || 'active')}>${esc(s.label)}</option>`).join('')}</select></div>
        <div class="field"><label for="rp-employee-ytd">Plan employee YTD</label><input class="input" id="rp-employee-ytd" name="employeeContributionYTD" type="number" step="0.01" min="0" value="${esc(p.employeeContributionYTD ?? 0)}"/></div>
        <div class="field"><label for="rp-employer-ytd">Plan employer YTD</label><input class="input" id="rp-employer-ytd" name="employerContributionYTD" type="number" step="0.01" min="0" value="${esc(p.employerContributionYTD ?? 0)}"/></div>
      </div>
      <div class="field"><label for="rp-notes">Notes</label><textarea class="input" id="rp-notes" name="notes" placeholder="Provider contact, plan documents, or anything you want to remember">${esc(p.notes || '')}</textarea></div>
      <div class="form-error" id="retirement-plan-error"></div>
      <div class="modal-actions"><button type="button" class="btn" data-action="modal-close">Cancel</button><button class="btn btn-primary" type="submit">${p.id ? 'Save changes' : 'Add plan'}</button></div>
    </form>`);
}

function retirementAccountModal(id) {
  const d = store.data();
  const a = d.retirementAccounts.find(x => x.id === id) || {};
  const employeeOptions = d.employees.map(e =>
    `<option value="${esc(e.id)}" ${selected(e.id, a.employeeId)}>${esc(e.name || 'Unnamed employee')}${e.archived ? ' (archived)' : ''}</option>`).join('');
  const missingEmployee = a.employeeId && !d.employees.some(e => e.id === a.employeeId)
    ? `<option value="${esc(a.employeeId)}" selected>Former employee</option>` : '';
  const planOptions = d.retirementPlans.map(p =>
    `<option value="${esc(p.id)}" ${selected(p.id, a.planId)}>${esc(p.name || 'Unnamed plan')}</option>`).join('');
  const missingPlan = a.planId && !d.retirementPlans.some(p => p.id === a.planId)
    ? `<option value="${esc(a.planId)}" selected>Removed plan</option>` : '';
  openModal(`${modalHead(a.id ? 'Edit retirement account' : 'Add a retirement account', 'Balances and year-to-date contributions are entered manually.')}
    <form id="retirement-account-form"><input type="hidden" name="id" value="${esc(a.id || '')}"/>
      <div class="form-grid">
        <div class="field"><label for="ra-name">Account label</label><input class="input" id="ra-name" name="name" value="${esc(a.name || '')}" placeholder="Employer 401(k) balance" required/></div>
        <div class="field"><label for="ra-plan">Plan</label><select class="input" id="ra-plan" name="planId"><option value="" ${selected('', a.planId || '')}>Unassigned plan</option>${missingPlan}${planOptions}</select></div>
        <div class="field"><label for="ra-employee">Employee</label><select class="input" id="ra-employee" name="employeeId"><option value="" ${selected('', a.employeeId || '')}>Former employee / unassigned</option>${missingEmployee}${employeeOptions}</select></div>
        <div class="field"><label for="ra-status">Status</label><select class="input" id="ra-status" name="status">${RETIREMENT_ACCOUNT_STATUSES.map(s => `<option value="${esc(s.value)}" ${selected(s.value, a.status || 'active')}>${esc(s.label)}</option>`).join('')}</select></div>
        <div class="field"><label for="ra-balance">Current balance</label><input class="input" id="ra-balance" name="balance" type="number" step="0.01" min="0" value="${esc(a.balance ?? 0)}" required/></div>
        <div class="field"><label for="ra-vested">Vested percent</label><input class="input" id="ra-vested" name="vestedPercent" type="number" step="0.01" min="0" max="100" value="${esc(a.vestedPercent ?? 100)}"/></div>
        <div class="field"><label for="ra-employee-ytd">Employee YTD</label><input class="input" id="ra-employee-ytd" name="employeeYTD" type="number" step="0.01" min="0" value="${esc(a.employeeYTD ?? 0)}"/></div>
        <div class="field"><label for="ra-employer-ytd">Employer YTD</label><input class="input" id="ra-employer-ytd" name="employerYTD" type="number" step="0.01" min="0" value="${esc(a.employerYTD ?? 0)}"/></div>
        <div class="field"><label for="ra-deferral">Deferral rate (%)</label><input class="input" id="ra-deferral" name="deferralRate" type="number" step="0.01" min="0" max="100" value="${esc(a.deferralRate ?? 0)}"/></div>
      </div>
      <div class="field"><label for="ra-notes">Notes</label><textarea class="input" id="ra-notes" name="notes" placeholder="Contribution notes or review dates">${esc(a.notes || '')}</textarea></div>
      <div class="form-error" id="retirement-account-error"></div>
      <div class="modal-actions"><button type="button" class="btn" data-action="modal-close">Cancel</button><button class="btn btn-primary" type="submit">${a.id ? 'Save changes' : 'Add account'}</button></div>
    </form>`);
}

function importModal() {
  openModal(`${modalHead('Import JSON', 'Paste an Atlas Business export or choose a file. This replaces the current workspace data.')}
    <form id="import-form">
      <div class="field"><label for="import-file">Choose file</label><input class="input" id="import-file" type="file" accept="application/json,.json"/></div>
      <div class="field"><label for="import-json">JSON data</label><textarea class="input" id="import-json" rows="8" placeholder="{ &quot;app&quot;: &quot;Atlas Business&quot;, … }"></textarea></div>
      <div class="form-error" id="import-error"></div>
      <div class="modal-actions"><button type="button" class="btn" data-action="modal-close">Cancel</button><button class="btn btn-primary" type="submit">Import data</button></div>
    </form>`);
}

function quickAddModal() {
  openModal(`${modalHead('Quick add', 'Choose what you want to record.')}
    <div class="quick-grid">
      ${[['add-employee', '♙', 'Employee', 'Person + pay details'], ['new-payroll', '▤', 'Pay period', 'Generate pay items'],
        ['add-debt', '◇', 'Debt', 'Balance + minimum'], ['add-invoice', '▧', 'Invoice', 'Client + amount'],
        ['add-expense', '◈', 'Expense', 'Vendor + category'], ['add-account', '▤', 'Account', 'Manual balance'],
        ['add-transaction', '↔', 'Transaction', 'Income or expense'], ['add-budget', '◈', 'Budget', 'Category limit'],
        ['add-detail', '▦', 'Record', 'Date or contact'], ['add-group', '⌁', 'Shared group', 'Members list'],
        ['add-retirement-plan', '◴', 'Retirement plan', '401(k), IRA or HSA'],
        ['add-retirement-account', '♙', 'Member account', 'Balance + contributions']]
        .map(([action, icon, title, sub]) => `<button type="button" class="quick-btn" data-action="${action}"><b>${icon} ${esc(title)}</b><span>${esc(sub)}</span></button>`).join('')}
    </div>`);
}

/* -------------------------------- actions -------------------------------- */

const actions = {
  'toggle-theme': () => {
    const next = store.getPrefs().theme === 'ink' ? 'paper' : 'ink';
    store.setPref('theme', next);
    applyTheme(); render();
  },
  'set-auth-backend': el => { state.authBackend = el.dataset.backend || 'auto'; render(); },
  'retry-cloud': async () => {
    state.cloud.bannerDismissed = false;
    await checkCloud();
    if (store.authMode() === 'cloud' && state.cloud.phase === 'online') syncEventsForCurrentConfig();
    toast(state.cloud.available ? 'Cloud endpoint is reachable.' : 'Cloud endpoint is still unavailable.', state.cloud.available ? 'success' : 'error');
  },
  'dismiss-banner': () => { state.cloud.bannerDismissed = true; render(); },
  'auth-fallback-local': () => { state.authBackend = 'local'; render(); },
  'quick-add': () => quickAddModal(),
  'modal-close': () => closeModal(),
  'modal-backdrop': (el, e) => { if (e.target === el) closeModal(); },
  'onboard-theme': el => {
    state.onboarding.theme = el.dataset.theme === 'paper' ? 'paper' : 'ink';
    $$('[data-action="onboard-theme"]').forEach(b => b.classList.toggle('active', b.dataset.theme === state.onboarding.theme));
  },
  'onboard-type': el => {
    readOnboardFields();
    state.onboarding.starterType = el.dataset.type === 'account' ? 'account' : 'employee';
    onboardingModal();
  },
  'toggle-mobile-nav': () => { $('.sidebar')?.classList.toggle('mobile-open'); },
  'reset-employee-filters': () => {
    state.filters.employees = { search: '', department: 'all', status: 'all' }; render();
  },
  'money-tab': el => { state.moneyTab = el.dataset.tab || 'accounts'; render(); },

  'add-employee': () => employeeModal(),
  'edit-employee': el => employeeModal(el.dataset.id),
  'archive-employee': el => {
    store.updateData(d => { d.employees = d.employees.map(e => e.id === el.dataset.id ? { ...e, archived: true } : e); });
    toast('Employee archived.'); render();
  },
  'unarchive-employee': el => {
    store.updateData(d => { d.employees = d.employees.map(e => e.id === el.dataset.id ? { ...e, archived: false } : e); });
    toast('Employee restored.'); render();
  },
  'delete-employee': el => confirmModal({
    title: 'Delete this employee?', body: 'Payroll items already generated for this person will keep their recorded amounts.',
    action: 'confirm-delete-employee', id: el.dataset.id,
  }),
  'confirm-delete-employee': el => {
    store.updateData(d => { d.employees = d.employees.filter(e => e.id !== el.dataset.id); });
    closeModal(); toast('Employee deleted.'); render();
  },

  'new-payroll': () => payrollModal(),
  'edit-payroll': el => payrollModal(el.dataset.id),
  'generate-payroll': el => {
    const d = store.data();
    const run = d.payroll.find(r => r.id === el.dataset.id);
    if (!run) return;
    const existing = new Set((run.items || []).map(i => i.employeeId));
    const additions = activeEmployees(d).filter(e => !existing.has(e.id)).map(e => {
      const gross = periodGross(e);
      return { employeeId: e.id, gross, deductions: 0, taxes: 0, net: gross };
    });
    if (!additions.length) { toast('All active employees already have items in this run.', 'error'); return; }
    store.updateData(data => {
      data.payroll = data.payroll.map(r => r.id === run.id
        ? { ...r, items: [...(r.items || []), ...additions] } : r);
    });
    toast(`${additions.length} pay item${additions.length === 1 ? '' : 's'} generated.`); render();
  },
  'approve-payroll': el => {
    store.updateData(d => { d.payroll = d.payroll.map(r => r.id === el.dataset.id ? { ...r, status: 'approved' } : r); });
    toast('Payroll approved.'); render();
  },
  'mark-payroll-paid': el => {
    store.updateData(d => { d.payroll = d.payroll.map(r => r.id === el.dataset.id ? { ...r, status: 'paid' } : r); });
    toast('Payroll marked paid.'); render();
  },
  'edit-payroll-item': el => payrollItemModal(el.dataset.id, el.dataset.item),
  'remove-payroll-item': el => {
    store.updateData(d => {
      d.payroll = d.payroll.map(r => r.id === el.dataset.id
        ? { ...r, items: (r.items || []).filter(i => i.employeeId !== el.dataset.item) } : r);
    });
    toast('Pay item removed.'); render();
  },
  'recalc-net': () => {
    const gross = Number($('#pi-gross')?.value) || 0;
    const deductions = Number($('#pi-deductions')?.value) || 0;
    const taxes = Number($('#pi-taxes')?.value) || 0;
    const netEl = $('#pi-net');
    if (netEl) netEl.value = String(round(gross - deductions - taxes));
  },
  'export-payroll': el => {
    const d = store.data();
    const run = d.payroll.find(r => r.id === el.dataset.id);
    if (!run) return;
    const rows = [['Period start', 'Period end', 'Pay date', 'Status', 'Employee', 'Gross', 'Deductions', 'Taxes', 'Net']];
    (run.items || []).forEach(item => {
      const emp = d.employees.find(e => e.id === item.employeeId);
      rows.push([
        run.periodStart || '', run.periodEnd || '', run.payDate || '', run.status || 'draft',
        emp?.name || 'Removed employee', item.gross || 0, item.deductions || 0, item.taxes || 0, item.net || 0,
      ]);
    });
    const t = payrollTotals(run);
    rows.push(['', '', '', 'TOTAL', `${t.count} employees`, t.gross, t.deductions, t.taxes, t.net]);
    downloadText(`atlas-business-payroll-${run.payDate || dateInput()}.csv`,
      rows.map(r => r.map(csvCell).join(',')).join('\r\n'), 'text/csv;charset=utf-8');
    toast('Payroll CSV exported.');
  },
  'delete-payroll': el => confirmModal({
    title: 'Delete this pay period?', body: 'Its recorded items and totals will be removed.',
    action: 'confirm-delete-payroll', id: el.dataset.id,
  }),
  'confirm-delete-payroll': el => {
    store.updateData(d => { d.payroll = d.payroll.filter(r => r.id !== el.dataset.id); });
    closeModal(); toast('Pay period deleted.'); render();
  },

  'add-debt': () => debtModal(),
  'edit-debt': el => debtModal(el.dataset.id),
  'record-debt-payment': el => debtPaymentModal(el.dataset.id),
  'delete-debt': el => confirmModal({
    title: 'Delete this debt?', body: 'Recorded payments stay in the history but will no longer be linked to this debt.',
    action: 'confirm-delete-debt', id: el.dataset.id,
  }),
  'confirm-delete-debt': el => {
    store.updateData(d => { d.debts = d.debts.filter(x => x.id !== el.dataset.id); });
    closeModal(); toast('Debt deleted.'); render();
  },

  'add-account': () => accountModal(),
  'edit-account': el => accountModal(el.dataset.id),
  'archive-account': el => {
    store.updateData(d => { d.accounts = d.accounts.map(a => a.id === el.dataset.id ? { ...a, archived: true } : a); });
    toast('Account archived.'); render();
  },
  'unarchive-account': el => {
    store.updateData(d => { d.accounts = d.accounts.map(a => a.id === el.dataset.id ? { ...a, archived: false } : a); });
    toast('Account restored.'); render();
  },
  'delete-account-row': el => confirmModal({
    title: 'Delete this account?', body: 'Transactions linked to it will remain but show as unassigned.',
    action: 'confirm-delete-account', id: el.dataset.id,
  }),
  'confirm-delete-account': el => {
    store.updateData(d => { d.accounts = d.accounts.filter(a => a.id !== el.dataset.id); });
    closeModal(); toast('Account deleted.'); render();
  },
  'add-transaction': () => transactionModal(),
  'edit-transaction': el => transactionModal(el.dataset.id),
  'delete-transaction': el => confirmModal({
    title: 'Delete this transaction?', body: 'The account balance is not changed automatically.',
    action: 'confirm-delete-transaction', id: el.dataset.id,
  }),
  'confirm-delete-transaction': el => {
    store.updateData(d => { d.transactions = d.transactions.filter(t => t.id !== el.dataset.id); });
    closeModal(); toast('Transaction deleted.'); render();
  },
  'add-budget': () => budgetModal(),
  'edit-budget': el => budgetModal(el.dataset.id),
  'delete-budget': el => confirmModal({
    title: 'Delete this budget?', body: 'Transactions in this category stay intact.',
    action: 'confirm-delete-budget', id: el.dataset.id,
  }),
  'confirm-delete-budget': el => {
    store.updateData(d => { d.budgets = d.budgets.filter(b => b.id !== el.dataset.id); });
    closeModal(); toast('Budget deleted.'); render();
  },

  'add-invoice': () => invoiceModal(),
  'edit-invoice': el => invoiceModal(el.dataset.id),
  'pay-invoice': el => {
    store.updateData(d => { d.invoices = d.invoices.map(i => i.id === el.dataset.id ? { ...i, status: 'paid' } : i); });
    toast('Invoice marked paid.'); render();
  },
  'delete-invoice': el => confirmModal({
    title: 'Delete this invoice?', body: 'This only removes your manual record.',
    action: 'confirm-delete-invoice', id: el.dataset.id,
  }),
  'confirm-delete-invoice': el => {
    store.updateData(d => { d.invoices = d.invoices.filter(i => i.id !== el.dataset.id); });
    closeModal(); toast('Invoice deleted.'); render();
  },
  'add-expense': () => expenseModal(),
  'edit-expense': el => expenseModal(el.dataset.id),
  'delete-expense': el => confirmModal({
    title: 'Delete this expense?', body: 'Top-vendor totals will update automatically.',
    action: 'confirm-delete-expense', id: el.dataset.id,
  }),
  'confirm-delete-expense': el => {
    store.updateData(d => { d.expenses = d.expenses.filter(e => e.id !== el.dataset.id); });
    closeModal(); toast('Expense deleted.'); render();
  },

  'add-group': () => groupModal(),
  'edit-group': el => groupModal(el.dataset.id),
  'delete-group': el => confirmModal({
    title: 'Delete this group?', body: 'Its shared expenses will also be removed.',
    action: 'confirm-delete-group', id: el.dataset.id,
  }),
  'confirm-delete-group': el => {
    store.updateData(d => {
      d.groups = d.groups.filter(g => g.id !== el.dataset.id);
      d.sharedExpenses = d.sharedExpenses.filter(x => x.groupId !== el.dataset.id);
    });
    closeModal(); toast('Group deleted.'); render();
  },
  'add-shared-expense': el => sharedExpenseModal(el.dataset.id),
  'delete-shared-expense': el => confirmModal({
    title: 'Delete this shared expense?', body: 'Member balances will be recalculated.',
    action: 'confirm-delete-shared-expense', id: el.dataset.id,
  }),
  'confirm-delete-shared-expense': el => {
    store.updateData(d => { d.sharedExpenses = d.sharedExpenses.filter(x => x.id !== el.dataset.id); });
    closeModal(); toast('Shared expense deleted.'); render();
  },

  'add-detail': () => detailModal(),
  'edit-detail': el => detailModal(el.dataset.id),
  'delete-detail': el => confirmModal({
    title: 'Delete this record?', body: 'Due-date reminders from this record will disappear.',
    action: 'confirm-delete-detail', id: el.dataset.id,
  }),
  'confirm-delete-detail': el => {
    store.updateData(d => { d.details = d.details.filter(x => x.id !== el.dataset.id); });
    closeModal(); toast('Record deleted.'); render();
  },

  'add-retirement-plan': () => retirementPlanModal(),
  'edit-retirement-plan': el => retirementPlanModal(el.dataset.id),
  'delete-retirement-plan': el => confirmModal({
    title: 'Delete this retirement plan?', body: 'Employee accounts stay in the workspace and will be shown as an unassigned plan. Recorded balances are not removed.',
    action: 'confirm-delete-retirement-plan', id: el.dataset.id,
  }),
  'confirm-delete-retirement-plan': el => {
    store.updateData(d => { d.retirementPlans = d.retirementPlans.filter(p => p.id !== el.dataset.id); });
    closeModal(); toast('Retirement plan deleted.'); render();
  },
  'add-retirement-account': () => retirementAccountModal(),
  'edit-retirement-account': el => retirementAccountModal(el.dataset.id),
  'delete-retirement-account': el => confirmModal({
    title: 'Delete this retirement account?', body: 'Only this manual balance and contribution record will be removed. The employee and plan records stay intact.',
    action: 'confirm-delete-retirement-account', id: el.dataset.id,
  }),
  'confirm-delete-retirement-account': el => {
    store.updateData(d => { d.retirementAccounts = d.retirementAccounts.filter(a => a.id !== el.dataset.id); });
    closeModal(); toast('Retirement account deleted.'); render();
  },

  'unlink-meridian': () => confirmModal({
    title: 'Unlink Meridian?', body: 'The imported read-only snapshot will be removed. Your Meridian account is unchanged.',
    action: 'confirm-unlink-meridian', id: 'meridian',
  }),
  'confirm-unlink-meridian': () => {
    store.updateData(d => {
      d.investments = null; d.settings.linkedMeridian = false; d.settings.meridianToken = '';
    });
    closeModal(); toast('Meridian unlinked.'); render();
  },

  'export-data': () => {
    downloadText(`atlas-business-${dateInput()}.json`, store.exportData(), 'application/json');
    toast('Atlas Business data exported.');
  },
  'import-data': () => importModal(),
  'clear-data': () => confirmModal({
    title: 'Clear all app data?', body: 'Employees, payroll, debts, accounts, retirement plans and accounts, invoices, expenses, records and the Meridian snapshot will be removed from this workspace.',
    action: 'confirm-clear-data', id: 'all',
  }),
  'confirm-clear-data': () => {
    store.clearData(); closeModal(); toast('App data cleared.'); render();
  },
  'cloud-signout': () => confirmModal({
    title: 'Sign out of cloud sync?', body: 'Your local data stays in this browser. Live sync and event updates stop until you sign in again.',
    action: 'confirm-cloud-signout', id: 'cloud',
  }),
  'confirm-cloud-signout': () => {
    stopEvents(); store.signOut();
    state.cloud.status = 'local'; state.syncReady = false;
    closeModal(); toast('Signed out of cloud sync.'); render();
  },
  'delete-profile': () => confirmModal({
    title: 'Delete this account?', body: 'For browser accounts, local credentials and all data for this account are removed. Cloud accounts are signed out locally; use your cloud provider to close the account.',
    action: 'confirm-delete-profile', id: 'me',
  }),
  'confirm-delete-profile': () => {
    stopEvents(); store.deleteAccount();
    state.syncReady = false; state.cloud.status = 'local';
    closeModal(); toast('Account deleted.'); go(ROUTES.landing);
  },
};

document.addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  if (action === 'modal-backdrop' && e.target !== el) return;
  const handler = actions[action];
  if (!handler) return;
  if (['modal-close', 'recalc-net', 'toggle-theme', 'money-tab', 'onboard-theme', 'onboard-type',
    'reset-employee-filters', 'toggle-mobile-nav', 'dismiss-banner', 'set-auth-backend',
    'auth-fallback-local', 'quick-add'].includes(action)) { handler(el, e); return; }
  try { const result = handler(el, e); if (result && typeof result.catch === 'function') result.catch(() => toast('That action could not be completed.', 'error')); }
  catch { toast('That action could not be completed.', 'error'); }
});

/* --------------------------------- forms --------------------------------- */

const forms = {
  'signin-form': async (form, fd) => {
    state.lastAuth = {
      kind: 'signin', email: String(fd.get('email') || '').trim(), password: String(fd.get('password') || ''),
    };
    await performAuth('signin', effectiveBackend());
  },
  'signup-form': async (form, fd) => {
    state.lastAuth = {
      kind: 'signup', name: String(fd.get('name') || ''),
      email: String(fd.get('email') || '').trim(), password: String(fd.get('password') || ''),
    };
    await performAuth('signup', effectiveBackend());
  },
  'onboarding-form': () => finishOnboarding(),
  'employee-form': (form, fd) => {
    const name = String(fd.get('name') || '').trim();
    if (!name) { $('#employee-error').textContent = 'Enter a name for this employee.'; return; }
    const id = String(fd.get('id') || '');
    const rate = Math.max(0, Number(fd.get('rate')) || 0);
    const payload = {
      name, email: String(fd.get('email') || '').trim(), role: String(fd.get('role') || '').trim(),
      department: String(fd.get('department') || '').trim() || 'Other', payType: String(fd.get('payType') || 'salary'),
      rate, payFrequency: String(fd.get('payFrequency') || 'biweekly'), startDate: String(fd.get('startDate') || dateInput()),
      status: String(fd.get('status') || 'active'),
    };
    store.updateData(d => {
      if (id) d.employees = d.employees.map(e => e.id === id ? { ...e, ...payload } : e);
      else d.employees.push({ id: uid('emp'), ...payload, archived: false });
    });
    closeModal(); toast(id ? 'Employee updated.' : 'Employee added.'); render();
  },
  'payroll-form': (form, fd) => {
    const start = String(fd.get('periodStart') || '');
    const end = String(fd.get('periodEnd') || '');
    if (!start || !end) { $('#payroll-error').textContent = 'Choose a period start and end date.'; return; }
    const id = String(fd.get('id') || '');
    const payload = {
      periodStart: start, periodEnd: end, payDate: String(fd.get('payDate') || end),
      status: String(fd.get('status') || 'draft'), notes: String(fd.get('notes') || ''),
    };
    store.updateData(d => {
      if (id) d.payroll = d.payroll.map(r => r.id === id ? { ...r, ...payload } : r);
      else d.payroll.push({ id: uid('pay'), ...payload, items: [] });
    });
    closeModal(); toast(id ? 'Pay period updated.' : 'Pay period created.'); render();
  },
  'payroll-item-form': (form, fd) => {
    const runId = String(fd.get('runId') || '');
    const employeeId = String(fd.get('employeeId') || '');
    const payload = {
      employeeId, gross: Number(fd.get('gross')) || 0, deductions: Number(fd.get('deductions')) || 0,
      taxes: Number(fd.get('taxes')) || 0, net: Number(fd.get('net')) || 0,
    };
    store.updateData(d => {
      d.payroll = d.payroll.map(r => {
        if (r.id !== runId) return r;
        const items = Array.isArray(r.items) ? r.items : [];
        return { ...r, items: items.some(i => i.employeeId === employeeId)
          ? items.map(i => i.employeeId === employeeId ? { ...i, ...payload } : i) : [...items, payload] };
      });
    });
    closeModal(); toast('Pay item saved.'); render();
  },
  'debt-form': (form, fd) => {
    const name = String(fd.get('name') || '').trim();
    if (!name) { $('#debt-error').textContent = 'Enter a name for this debt.'; return; }
    const id = String(fd.get('id') || '');
    const payload = {
      name, creditor: String(fd.get('creditor') || '').trim(), type: String(fd.get('type') || 'loan'),
      priority: String(fd.get('priority') || 'medium'), original: Math.max(0, Number(fd.get('original')) || 0),
      balance: Math.max(0, Number(fd.get('balance')) || 0), rate: Math.max(0, Number(fd.get('rate')) || 0),
      minimumPayment: Math.max(0, Number(fd.get('minimumPayment')) || 0), dueDate: String(fd.get('dueDate') || ''),
      notes: String(fd.get('notes') || ''),
    };
    store.updateData(d => {
      if (id) d.debts = d.debts.map(x => x.id === id ? { ...x, ...payload } : x);
      else d.debts.push({ id: uid('debt'), ...payload });
    });
    closeModal(); toast(id ? 'Debt updated.' : 'Debt added.'); render();
  },
  'debt-payment-form': (form, fd) => {
    const amount = Math.max(0, Number(fd.get('amount')) || 0);
    if (amount <= 0) { $('#debt-payment-error').textContent = 'Enter an amount greater than zero.'; return; }
    const debtId = String(fd.get('debtId') || '');
    store.updateData(d => {
      d.debtPayments.push({
        id: uid('pay'), debtId, date: String(fd.get('date') || dateInput()), amount,
        note: String(fd.get('note') || ''),
      });
      if (fd.get('reduceBalance') === 'on') {
        d.debts = d.debts.map(x => x.id === debtId
          ? { ...x, balance: Math.max(0, round((Number(x.balance) || 0) - amount)) } : x);
      }
    });
    closeModal(); toast('Debt payment recorded.'); render();
  },
  'account-form': (form, fd) => {
    const name = String(fd.get('name') || '').trim();
    const balance = Number(fd.get('balance'));
    if (!name || !Number.isFinite(balance)) { $('#account-error').textContent = 'Give the account a name and a valid balance.'; return; }
    const id = String(fd.get('id') || '');
    const payload = {
      name, institution: String(fd.get('institution') || 'Manual entry').trim(),
      type: String(fd.get('type') || 'Other'), mask: String(fd.get('mask') || '').trim(),
      balance, color: safeColor(fd.get('color')), archived: false,
    };
    store.updateData(d => {
      if (id) d.accounts = d.accounts.map(a => a.id === id ? { ...a, ...payload } : a);
      else d.accounts.push({ id: uid('acc'), ...payload });
    });
    closeModal(); toast(id ? 'Account updated.' : 'Account added.'); render();
  },
  'transaction-form': (form, fd) => {
    const description = String(fd.get('description') || '').trim();
    const amount = Number(fd.get('amount'));
    if (!description || !(amount >= 0)) { $('#transaction-error').textContent = 'Enter a description and a positive amount.'; return; }
    const id = String(fd.get('id') || '');
    const payload = {
      accountId: String(fd.get('accountId') || ''), date: String(fd.get('date') || dateInput()),
      description, category: String(fd.get('category') || 'Other'), amount,
      type: String(fd.get('type') || 'expense'),
    };
    store.updateData(d => {
      if (id) d.transactions = d.transactions.map(t => t.id === id ? { ...t, ...payload } : t);
      else d.transactions.push({ id: uid('tx'), ...payload });
    });
    closeModal(); toast(id ? 'Transaction updated.' : 'Transaction recorded.'); render();
  },
  'budget-form': (form, fd) => {
    const limit = Number(fd.get('limit'));
    if (!(limit >= 0)) { $('#budget-error').textContent = 'Enter a valid limit.'; return; }
    const id = String(fd.get('id') || '');
    const payload = {
      category: String(fd.get('category') || 'Other'), limit, period: String(fd.get('period') || 'monthly'),
    };
    store.updateData(d => {
      if (id) d.budgets = d.budgets.map(b => b.id === id ? { ...b, ...payload } : b);
      else d.budgets.push({ id: uid('bud'), ...payload });
    });
    closeModal(); toast(id ? 'Budget updated.' : 'Budget created.'); render();
  },
  'invoice-form': (form, fd) => {
    const client = String(fd.get('client') || '').trim();
    if (!client) { $('#invoice-error').textContent = 'Enter a client name.'; return; }
    const id = String(fd.get('id') || '');
    const payload = {
      client, amount: Math.max(0, Number(fd.get('amount')) || 0),
      issueDate: String(fd.get('issueDate') || dateInput()), dueDate: String(fd.get('dueDate') || ''),
      status: String(fd.get('status') || 'draft'), notes: String(fd.get('notes') || ''),
    };
    store.updateData(d => {
      if (id) d.invoices = d.invoices.map(i => i.id === id ? { ...i, ...payload } : i);
      else d.invoices.push({ id: uid('inv'), ...payload });
    });
    closeModal(); toast(id ? 'Invoice updated.' : 'Invoice created.'); render();
  },
  'expense-form': (form, fd) => {
    const vendor = String(fd.get('vendor') || '').trim();
    if (!vendor) { $('#expense-error').textContent = 'Enter a vendor name.'; return; }
    const id = String(fd.get('id') || '');
    const payload = {
      vendor, date: String(fd.get('date') || dateInput()), category: String(fd.get('category') || 'Other'),
      amount: Math.max(0, Number(fd.get('amount')) || 0), status: String(fd.get('status') || 'pending'),
      accountId: String(fd.get('accountId') || ''), notes: String(fd.get('notes') || ''),
    };
    store.updateData(d => {
      if (id) d.expenses = d.expenses.map(e => e.id === id ? { ...e, ...payload } : e);
      else d.expenses.push({ id: uid('exp'), ...payload });
    });
    closeModal(); toast(id ? 'Expense updated.' : 'Expense added.'); render();
  },
  'group-form': (form, fd) => {
    const name = String(fd.get('name') || '').trim();
    if (!name) { $('#group-error').textContent = 'Enter a group name.'; return; }
    const id = String(fd.get('id') || '');
    const existing = store.data().groups.find(g => g.id === id);
    const oldMembers = groupMembers(existing);
    const names = String(fd.get('members') || '').split('\n').map(s => s.trim()).filter(Boolean);
    if (!names.length) { $('#group-error').textContent = 'Add at least one member.'; return; }
    const members = names.map(n => {
      const found = oldMembers.find(m => m.name.toLowerCase() === n.toLowerCase());
      return found || { id: uid('mem'), name: n };
    });
    store.updateData(d => {
      if (id) d.groups = d.groups.map(g => g.id === id ? { ...g, name, members } : g);
      else d.groups.push({ id: uid('grp'), name, members });
    });
    closeModal(); toast(id ? 'Group updated.' : 'Group created.'); render();
  },
  'shared-expense-form': (form, fd) => {
    const d = store.data();
    const group = d.groups.find(g => g.id === String(fd.get('groupId') || ''));
    if (!group) { $('#shared-expense-error').textContent = 'That group no longer exists.'; return; }
    const title = String(fd.get('title') || '').trim();
    const total = Math.max(0, Number(fd.get('amount')) || 0);
    if (!title || total <= 0) { $('#shared-expense-error').textContent = 'Enter a title and a positive amount.'; return; }
    const split = String(fd.get('split') || 'equal');
    const shares = {}, custom = {};
    if (split === 'shares') {
      groupMembers(group).forEach(m => { shares[m.id] = Math.max(0, Number(fd.get(`shares_${m.id}`)) || 0); });
      if (sum(Object.values(shares)) <= 0) { $('#shared-expense-error').textContent = 'Enter at least one share greater than zero.'; return; }
    }
    if (split === 'custom') {
      groupMembers(group).forEach(m => { custom[m.id] = Math.max(0, Number(fd.get(`custom_${m.id}`)) || 0); });
      if (Math.abs(sum(Object.values(custom)) - total) > 0.011) {
        $('#shared-expense-error').textContent = `Custom amounts must add up to ${fmt(total)} (currently ${fmt(sum(Object.values(custom))) }).`;
        return;
      }
    }
    store.updateData(data => {
      data.sharedExpenses.push({
        id: uid('share'), groupId: group.id, date: String(fd.get('date') || dateInput()),
        title, amount: total, payerId: String(fd.get('payerId') || ''), split,
        shares, custom, category: String(fd.get('category') || 'Other'), note: String(fd.get('note') || ''),
      });
    });
    closeModal(); toast('Shared expense added.'); render();
  },
  'detail-form': (form, fd) => {
    const title = String(fd.get('title') || '').trim();
    if (!title) { $('#detail-error').textContent = 'Enter a title for this record.'; return; }
    const id = String(fd.get('id') || '');
    const payload = {
      title, type: String(fd.get('type') || 'note'), value: String(fd.get('value') || ''),
      dueDate: String(fd.get('dueDate') || ''), notes: String(fd.get('notes') || ''),
    };
    store.updateData(d => {
      if (id) d.details = d.details.map(x => x.id === id ? { ...x, ...payload } : x);
      else d.details.push({ id: uid('det'), ...payload });
    });
    closeModal(); toast(id ? 'Record updated.' : 'Record added.'); render();
  },
  'retirement-plan-form': (form, fd) => {
    const name = String(fd.get('name') || '').trim();
    const employeeYTD = Number(fd.get('employeeContributionYTD'));
    const employerYTD = Number(fd.get('employerContributionYTD'));
    if (!name || !(employeeYTD >= 0) || !(employerYTD >= 0)) {
      $('#retirement-plan-error').textContent = 'Enter a plan name and contribution totals of zero or more.';
      return;
    }
    let type = String(fd.get('type') || 'other');
    if (!RETIREMENT_TYPES.some(t => t.value === type)) type = 'other';
    let status = String(fd.get('status') || 'active');
    if (!RETIREMENT_PLAN_STATUSES.some(s => s.value === status)) status = 'active';
    const id = String(fd.get('id') || '');
    const payload = {
      name, type, provider: String(fd.get('provider') || '').trim(),
      planNumber: String(fd.get('planNumber') || '').trim(),
      employerMatchFormula: String(fd.get('employerMatchFormula') || '').trim(),
      vestingSchedule: String(fd.get('vestingSchedule') || '').trim(),
      eligibility: String(fd.get('eligibility') || '').trim(),
      employeeContributionYTD: employeeYTD, employerContributionYTD: employerYTD,
      status, notes: String(fd.get('notes') || '').trim(), updatedAt: new Date().toISOString(),
    };
    store.updateData(d => {
      if (id) d.retirementPlans = d.retirementPlans.map(p => p.id === id ? { ...p, ...payload } : p);
      else d.retirementPlans.push({ id: uid('rplan'), ...payload });
    });
    closeModal(); toast(id ? 'Retirement plan updated.' : 'Retirement plan added.'); render();
  },
  'retirement-account-form': (form, fd) => {
    const name = String(fd.get('name') || '').trim();
    const balance = Number(fd.get('balance'));
    const employeeYTD = Number(fd.get('employeeYTD'));
    const employerYTD = Number(fd.get('employerYTD'));
    const vestedPercent = Number(fd.get('vestedPercent'));
    const deferralRate = Number(fd.get('deferralRate'));
    if (!name || !(balance >= 0) || !(employeeYTD >= 0) || !(employerYTD >= 0)
      || !Number.isFinite(vestedPercent) || vestedPercent < 0 || vestedPercent > 100
      || !Number.isFinite(deferralRate) || deferralRate < 0 || deferralRate > 100) {
      $('#retirement-account-error').textContent = 'Enter a label, a balance of zero or more, and percentages between 0 and 100.';
      return;
    }
    let status = String(fd.get('status') || 'active');
    if (!RETIREMENT_ACCOUNT_STATUSES.some(s => s.value === status)) status = 'active';
    const id = String(fd.get('id') || '');
    const payload = {
      planId: String(fd.get('planId') || ''), employeeId: String(fd.get('employeeId') || ''),
      name, balance, employeeYTD, employerYTD, vestedPercent, deferralRate, status,
      notes: String(fd.get('notes') || '').trim(), updatedAt: new Date().toISOString(),
    };
    store.updateData(d => {
      if (id) d.retirementAccounts = d.retirementAccounts.map(a => a.id === id ? { ...a, ...payload } : a);
      else d.retirementAccounts.push({ id: uid('racct'), ...payload });
    });
    closeModal(); toast(id ? 'Retirement account updated.' : 'Retirement account added.'); render();
  },
  'import-form': () => {
    const result = store.importData($('#import-json')?.value || '');
    if (!result.ok) { $('#import-error').textContent = result.error || 'Import failed.'; return; }
    closeModal(); toast('Atlas Business data imported.'); render();
  },
  'company-form': (form, fd) => {
    const name = String(fd.get('name') || '').trim();
    store.updateData(d => {
      d.company = {
        name, industry: String(fd.get('industry') || '').trim(),
        size: String(fd.get('size') || '').trim(), ein: String(fd.get('ein') || '').trim(),
      };
      d.settings.name = name || d.settings.name;
    });
    toast('Company details saved.'); render();
  },
  'endpoint-form': async () => {
    store.setSyncEndpoint($('#sync-endpoint-input')?.value || '');
    await checkCloud({ silent: true });
    syncEventsForCurrentConfig();
    toast(state.cloud.available ? 'Endpoint saved and reachable.' : 'Endpoint saved, but cloud is unavailable.', state.cloud.available ? 'success' : 'error');
    render();
  },
  'settings-endpoint-form': async () => {
    store.setSyncEndpoint($('#settings-endpoint-input')?.value || '');
    await checkCloud({ silent: true });
    syncEventsForCurrentConfig();
    toast(state.cloud.available ? 'Endpoint saved and reachable.' : 'Endpoint saved, but cloud is unavailable.', state.cloud.available ? 'success' : 'error');
    render();
  },
  'meridian-form': async (form, fd) => {
    if (state.connectorBusy) return;
    const code = String(fd.get('code') || '').trim();
    if (!code) { $('#meridian-error').textContent = 'Enter the pairing code from Meridian.'; return; }
    state.connectorBusy = true;
    const button = form.querySelector('button[type="submit"]');
    if (button) { button.disabled = true; button.textContent = 'Connecting…'; }
    try {
      const res = await api.redeemCode(code);
      if (!res.ok) { $('#meridian-error').textContent = res.error || 'That code could not be redeemed.'; return; }
      const token = res.data?.token || store.cloudToken();
      const snapshot = await api.getSnapshot(MERIDIAN_APP, token);
      if (!snapshot.ok || !snapshot.data) {
        $('#meridian-error').textContent = snapshot.error || 'The Meridian snapshot could not be loaded.';
        return;
      }
      store.updateData(d => {
        d.investments = snapshot.data;
        d.settings.linkedMeridian = true;
        if (res.data?.token) d.settings.meridianToken = String(res.data.token);
      });
      closeModal();
      toast('Meridian snapshot imported.');
      render();
    } finally {
      state.connectorBusy = false;
      if (button) { button.disabled = false; button.textContent = 'Redeem & import →'; }
    }
  },
};

document.addEventListener('submit', async e => {
  const form = e.target;
  const formId = form.getAttribute('id') || '';
  e.preventDefault();
  const handler = forms[formId];
  if (!handler) return;
  const fd = new FormData(form);
  try { await handler(form, fd); }
  catch { toast('Could not save that change.', 'error'); }
});

/* --------------------------- inputs and keys --------------------------- */

function refreshEmployees() {
  const tbody = $('#employee-tbody');
  if (!tbody) return;
  tbody.innerHTML = employeeRows(store.data());
  const count = $('#emp-count');
  if (count) count.textContent = `${store.data().employees.filter(e => !e.archived).length} active record(s)`;
}
function refreshTransactions() {
  const tbody = $('#tx-tbody');
  if (!tbody) return;
  const d = store.data();
  tbody.innerHTML = transactionRows(d);
  const count = $('#tx-count');
  if (count) count.textContent = `${d.transactions.length} record(s)`;
}
function refreshExpenses() {
  const tbody = $('#expense-tbody');
  if (!tbody) return;
  const d = store.data();
  tbody.innerHTML = expenseRows(d);
  const count = $('#expense-count');
  if (count) count.textContent = `${d.expenses.length} record(s)`;
}
function refreshDetails() {
  const host = $('#detail-list');
  if (!host) return;
  const type = state.filters.details.type;
  const rows = store.data().details.filter(x => type === 'all' || (x.type || 'note') === type)
    .sort((a, b) => String(a.dueDate || '9999').localeCompare(String(b.dueDate || '9999')));
  host.innerHTML = rows.length ? rows.map(detailCard).join('')
    : emptyState('▦', 'No matching records', 'Try another type or add a record.', `<button class="btn btn-primary" data-action="add-detail">Add a record</button>`);
}

document.addEventListener('input', e => {
  const id = e.target.id;
  if (id === 'emp-search') { state.filters.employees.search = e.target.value; refreshEmployees(); }
  if (id === 'tx-search') { state.filters.transactions.search = e.target.value; refreshTransactions(); }
  if (id === 'expense-search') { state.filters.expenses.search = e.target.value; refreshExpenses(); }
});

document.addEventListener('change', async e => {
  const el = e.target;
  if (el.id === 'emp-department') { state.filters.employees.department = el.value; refreshEmployees(); }
  if (el.id === 'emp-status') { state.filters.employees.status = el.value; refreshEmployees(); }
  if (el.id === 'tx-account') { state.filters.transactions.account = el.value; refreshTransactions(); }
  if (el.id === 'tx-category') { state.filters.transactions.category = el.value; refreshTransactions(); }
  if (el.id === 'tx-type') { state.filters.transactions.type = el.value; refreshTransactions(); }
  if (el.id === 'expense-status') { state.filters.expenses.status = el.value; refreshExpenses(); }
  if (el.id === 'detail-type') { state.filters.details.type = el.value; refreshDetails(); }
  if (el.id === 'theme-select') {
    store.setPref('theme', el.value); applyTheme(); render();
    const again = $('#theme-select'); if (again) again.focus();
  }
  if (el.id === 'currency-select') {
    store.setPref('currency', el.value); toast(`Display currency set to ${el.value}.`); render();
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
  if (e.key === 'Escape' && modalHost.innerHTML) { closeModal(); return; }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && route().page === 'money' && state.moneyTab === 'transactions') {
    const input = $('#tx-search');
    if (input) { e.preventDefault(); input.focus(); }
  }
});

window.addEventListener('hashchange', () => {
  closeModal();
  $('.sidebar')?.classList.remove('mobile-open');
  render();
});

/* ---------------------------------- boot ---------------------------------- */

async function boot() {
  applyTheme();
  initCalendarWidget({ app: 'business', getEndpoint: getSyncEndpoint, getToken: cloudToken });
  render();
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
  render();
  if (store.currentUser() && !store.getPrefs().onboardingComplete && route().mode === 'app') {
    prepareOnboarding('Finish setup to personalize Atlas Business.');
  }
}

boot().catch(() => { /* boot failures never leave an unhandled rejection */ });

