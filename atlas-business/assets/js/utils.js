/* Small shared helpers and deterministic business math. Dependency-free. */
import { CHART_COLORS, PAY_PERIODS, HOURS_PER_PERIOD } from './config.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export function money(value, currency = 'USD', opts = {}) {
  const n = Number(value) || 0;
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency', currency,
      minimumFractionDigits: opts.digits ?? 2,
      maximumFractionDigits: opts.digits ?? 2,
    }).format(n);
  } catch { return `${currency} ${n.toFixed(2)}`; }
}

export function num(value, digits = 2) {
  return (Number(value) || 0).toLocaleString('en-US', {
    minimumFractionDigits: digits, maximumFractionDigits: digits,
  });
}

export function pct(value, digits = 1) { return `${Number(value) || 0 > 0 ? '+' : ''}${(Number(value) || 0).toFixed(digits)}%`; }
export function signClass(value) { return Number(value) > 0 ? 'up' : Number(value) < 0 ? 'down' : 'flat'; }
export function round(value, digits = 2) {
  const f = 10 ** digits;
  return Math.round((Number(value) || 0) * f) / f;
}
export function sum(list, key) {
  return (Array.isArray(list) ? list : []).reduce((s, row) => s + (Number(key ? row?.[key] : row) || 0), 0);
}
export function clamp(n, min, max) { return Math.min(max, Math.max(min, Number(n) || 0)); }

export function uid(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}
export function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < String(str).length; i++) { h ^= String(str).charCodeAt(i); h = Math.imul(h, 16777619); }
  return Math.abs(h >>> 0);
}
export function colorFor(key, palette = CHART_COLORS) {
  return palette[hashString(String(key)) % palette.length];
}
export function safeColor(value, fallback = '#28b3a6') {
  const s = String(value || '').trim();
  return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(s) ? s : fallback;
}

export function dateInput(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}
export function addDays(date, days) {
  const d = date instanceof Date ? new Date(date) : new Date(date);
  d.setDate(d.getDate() + Number(days || 0));
  return d;
}
export function daysUntil(value) {
  if (!value) return null;
  const t = Date.parse(String(value).length === 10 ? `${value}T00:00:00` : value);
  if (Number.isNaN(t)) return null;
  return Math.ceil((t - Date.now()) / 86400000);
}
export function dateLabel(ts, opts = {}) {
  const d = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts ?? '');
  if (opts.relative) {
    const diff = (Date.now() - d.getTime()) / 60000;
    if (diff < 1) return 'just now';
    if (diff < 60) return `${Math.floor(diff)}m ago`;
    if (diff < 1440) return `${Math.floor(diff / 60)}h ago`;
    if (diff < 10080) return `${Math.floor(diff / 1440)}d ago`;
  }
  return d.toLocaleDateString('en-US', {
    month: opts.short ? 'short' : 'long', day: 'numeric',
    year: opts.year === false ? undefined : 'numeric',
  });
}
export function monthKey(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
export function monthLabel(key, short = true) {
  const [y, m] = String(key).split('-').map(Number);
  if (!y || !m) return String(key || '');
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', {
    month: short ? 'short' : 'long', year: '2-digit',
  });
}
export function initials(name = '') {
  return String(name).split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?';
}
export function safeParse(str, fallback) {
  try { return JSON.parse(str) ?? fallback; } catch { return fallback; }
}
export function debounce(fn, ms = 250) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
export function plural(n, one, many = `${one}s`) { return Number(n) === 1 ? one : many; }
export function titleCase(value) {
  return String(value || '').replace(/(^|\s)\S/g, s => s.toUpperCase());
}
export function csvCell(value) {
  const s = String(value ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export function downloadText(filename, text, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* -------------------------- deterministic business math -------------------------- */

export function periodsPerYear(frequency) { return PAY_PERIODS[frequency] || PAY_PERIODS.biweekly; }

export function periodGross(employee) {
  const rate = Math.max(0, Number(employee?.rate) || 0);
  const freq = employee?.payFrequency || 'biweekly';
  if (employee?.payType === 'salary') return round(rate / periodsPerYear(freq));
  const hours = HOURS_PER_PERIOD[freq] || HOURS_PER_PERIOD.biweekly;
  return round(rate * hours);
}

export function annualCost(employee) {
  return round(periodGross(employee) * periodsPerYear(employee?.payFrequency));
}

/* Simple deterministic amortization: fixed minimum payment, monthly interest.
   Returns a projection capped at 600 months so bad inputs can never hang. */
export function payoffProjection(debt, months = 600) {
  let balance = Math.max(0, Number(debt?.balance) || 0);
  const apr = Math.max(0, Number(debt?.rate) || 0);
  const monthlyRate = apr / 100 / 12;
  const minimum = Math.max(0, Number(debt?.minimumPayment) || 0);
  let interestTotal = 0;
  let elapsed = 0;
  if (balance <= 0) return { months: 0, interest: 0, paid: true };
  while (balance > 0.005 && elapsed < months) {
    const interest = balance * monthlyRate;
    const payment = Math.max(minimum, interest + 1);
    balance = Math.max(0, balance + interest - payment);
    interestTotal += interest;
    elapsed += 1;
  }
  return { months: elapsed, interest: round(interestTotal), paid: balance <= 0.005 };
}

export function monthsLabel(months) {
  if (months == null) return '—';
  if (months === 0) return 'Paid off';
  if (months < 12) return `${months} mo`;
  const y = Math.floor(months / 12); const m = months % 12;
  return `${y} yr${m ? ` ${m} mo` : ''}`;
}

export function effectiveAmount(tx) {
  const a = Math.abs(Number(tx?.amount) || 0);
  return tx?.type === 'income' ? a : tx?.type === 'expense' ? -a : 0;
}

/* Greedy settle-up: largest debtor pays largest creditor first. */
export function settleUp(balances) {
  const debtors = Object.entries(balances).filter(([, v]) => v < -0.005)
    .map(([name, value]) => ({ name, amount: round(-value) })).sort((a, b) => b.amount - a.amount);
  const creditors = Object.entries(balances).filter(([, v]) => v > 0.005)
    .map(([name, value]) => ({ name, amount: round(value) })).sort((a, b) => b.amount - a.amount);
  const out = [];
  let i = 0; let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const amount = round(Math.min(debtors[i].amount, creditors[j].amount));
    if (amount > 0) out.push({ from: debtors[i].name, to: creditors[j].name, amount });
    debtors[i].amount = round(debtors[i].amount - amount);
    creditors[j].amount = round(creditors[j].amount - amount);
    if (debtors[i].amount <= 0.005) i += 1;
    if (creditors[j].amount <= 0.005) j += 1;
  }
  return out;
}
