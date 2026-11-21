/* Small shared helpers. No dependencies, no build step. */
import { SECTOR_COLORS } from './config.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function money(value, currency = 'USD', opts = {}) {
  const n = Number(value) || 0;
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: opts.digits ?? (Math.abs(n) >= 1000 ? 2 : 2), minimumFractionDigits: opts.digits ?? 2 }).format(n);
  } catch { return `$${n.toFixed(2)}`; }
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

export function pct(value, digits = 2) {
  const n = Number(value) || 0;
  return `${n > 0 ? '+' : ''}${n.toFixed(digits)}%`;
}

export function num(value, digits = 2) {
  return (Number(value) || 0).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function signClass(value) { return Number(value) > 0 ? 'up' : Number(value) < 0 ? 'down' : 'flat'; }

export function uid(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return Math.abs(h >>> 0);
}

export function seededRandom(seed) {
  let s = hashString(String(seed)) || 1;
  return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
}

export function colorFor(key, palette = SECTOR_COLORS) {
  return palette[hashString(String(key)) % palette.length];
}

export function dateLabel(ts, opts = {}) {
  const d = ts instanceof Date ? ts : new Date(ts);
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
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?';
}

export function stripHtml(html = '') {
  const el = document.createElement('div');
  el.innerHTML = html;
  return el.textContent || '';
}

/* Deterministic, believable historical series anchored to a current price.
   Used as an offline fallback and for portfolio-level performance visualisation. */
export function syntheticSeries(symbol, currentPrice, days = 252, changePct = 0.6) {
  const rand = seededRandom(`series-${symbol}`);
  const out = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let v = currentPrice / (1 + (changePct || 0.6) / 100 * 12);
  const drift = Math.log(currentPrice / v) / days;
  const vol = 0.011 + rand() * 0.011;
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(today);
    date.setDate(today.getDate() - i);
    if (date.getDay() === 0 || date.getDay() === 6) continue;
    v = v * Math.exp(drift + (rand() - 0.5) * vol * 2);
    out.push({ date: date.toISOString().slice(0, 10), close: v });
  }
  if (out.length) out[out.length - 1].close = currentPrice;
  return out;
}

export function combineSeries(seriesBySymbol, weights = {}) {
  const dates = [...new Set(Object.values(seriesBySymbol).flatMap(s => s.map(p => p.date)))].sort();
  const base = {};
  let totalWeight = 0;
  for (const [sym, arr] of Object.entries(seriesBySymbol)) {
    const w = weights[sym] ?? 1;
    totalWeight += Math.abs(w);
    if (arr.length) base[sym] = arr[0].close;
  }
  if (!totalWeight) return [];
  return dates.map(date => {
    let sum = 0;
    for (const [sym, arr] of Object.entries(seriesBySymbol)) {
      const point = arr.find(p => p.date === date) || arr[arr.length - 1];
      if (!point || !base[sym]) continue;
      const w = Math.abs(weights[sym] ?? 1) / totalWeight;
      sum += w * (point.close / base[sym]);
    }
    return { date, value: sum };
  }).filter(p => p.value > 0);
}

export function sliceRange(series, range) {
  if (!series?.length) return [];
  const n = { '1W': 5, '1M': 22, '3M': 66, '6M': 126, '1Y': 252, 'ALL': 100000 }[range] ?? 66;
  return series.slice(-n);
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
