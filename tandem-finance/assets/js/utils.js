/* Small shared helpers and money math. Dependency-free and safe for templates. */
import { CATEGORY_COLORS, MEMBER_COLORS } from './config.js';

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

export function num(value, digits = 2) {
  return (Number(value) || 0).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function roundCents(value) {
  const n = Number(value) || 0;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/* Split an amount into integer cents using weights. The result always sums
   exactly to the requested total; leftover cents go to the largest remainders
   (with a stable index tie-break) so renders are deterministic. */
export function allocateCents(total, weights = []) {
  const totalCents = Math.max(0, Math.round((Number(total) || 0) * 100));
  const clean = weights.map(w => Math.max(0, Number(w) || 0));
  if (!clean.length) return [];
  const weightSum = clean.reduce((a, b) => a + b, 0);
  const effective = weightSum > 0 ? clean : clean.map(() => 1);
  const divisor = effective.reduce((a, b) => a + b, 0) || effective.length;
  const raw = effective.map(w => totalCents * w / divisor);
  const parts = raw.map(v => Math.floor(v + 1e-9));
  let remaining = totalCents - parts.reduce((a, b) => a + b, 0);
  const order = raw.map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => (b.frac - a.frac) || (a.i - b.i));
  for (let k = 0; remaining > 0 && k < order.length * 2; k++, remaining--) {
    parts[order[k % order.length].i] += 1;
  }
  return parts.map(c => c / 100);
}

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

export function memberColor(key) {
  return colorFor(key, MEMBER_COLORS);
}

export function safeColor(value, fallback = '#e9685a') {
  const s = String(value || '').trim();
  return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(s) ? s : fallback;
}

export function dateInput(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
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
  const d = date instanceof Date ? new Date(date) : new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function monthLabel(key, short = true) {
  const [y, m] = String(key).split('-').map(Number);
  if (!y || !m) return String(key || '');
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: short ? 'short' : 'long', year: '2-digit' });
}
