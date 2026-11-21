/* Small shared helpers. Dependency-free and safe for template rendering. */
import { CATEGORY_COLORS } from './config.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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

export function compact(value, currency = '') {
  const n = Number(value) || 0;
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  let out;
  if (abs >= 1e12) out = `${(abs / 1e12).toFixed(2)}T`;
  else if (abs >= 1e9) out = `${(abs / 1e9).toFixed(2)}B`;
  else if (abs >= 1e6) out = `${(abs / 1e6).toFixed(2)}M`;
  else if (abs >= 1e3) out = `${(abs / 1e3).toFixed(1)}K`;
  else out = abs.toFixed(2);
  return `${sign}${currency}${out}`;
}

export function num(value, digits = 2) {
  return (Number(value) || 0).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function pct(value, digits = 1) {
  const n = Number(value) || 0;
  return `${n > 0 ? '+' : ''}${n.toFixed(digits)}%`;
}

export function signClass(value) { return Number(value) > 0 ? 'up' : Number(value) < 0 ? 'down' : 'flat'; }

export function uid(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

export function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < String(str).length; i++) { h ^= String(str).charCodeAt(i); h = Math.imul(h, 16777619); }
  return Math.abs(h >>> 0);
}

export function colorFor(key, palette = CATEGORY_COLORS) {
  return palette[hashString(String(key)) % palette.length];
}

export function safeColor(value, fallback = '#3b82f6') {
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
  return d.toLocaleDateString('en-US', { month: opts.short ? 'short' : 'long', day: 'numeric', year: opts.year === false ? undefined : 'numeric' });
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

export function clamp(n, min, max) { return Math.min(max, Math.max(min, Number(n) || 0)); }

export function plural(n, one, many = `${one}s`) { return Number(n) === 1 ? one : many; }

export function titleCase(value) {
  return String(value || '').replace(/(^|\s)\S/g, s => s.toUpperCase());
}

export function monthKey(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function monthLabel(key, short = true) {
  const [y, m] = String(key).split('-').map(Number);
  if (!y || !m) return String(key || '');
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: short ? 'short' : 'long', year: '2-digit' });
}
