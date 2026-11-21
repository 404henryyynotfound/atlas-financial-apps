/* Small shared helpers: DOM, escaping, dates and formatting. Dependency-free. */
import { TYPE_IDS } from './config.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export function safeParse(str, fallback) {
  try { return JSON.parse(str) ?? fallback; } catch { return fallback; }
}

export function uid(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

export function clamp(n, min, max) { return Math.min(max, Math.max(min, Number(n) || 0)); }
export function plural(n, one, many = `${one}s`) { return Number(n) === 1 ? one : many; }
export function initials(name = '') {
  return String(name).split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || 'A';
}
export function debounce(fn, ms = 250) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}
export function safeType(type) { return TYPE_IDS.includes(type) ? type : 'personal'; }

export function downloadText(filename, text, mime = 'application/json;charset=utf-8') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function safeHref(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith('/') && !s.startsWith('//')) return s;
  return '';
}

/* ------------------------------- dates -------------------------------- */

export function parseDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : new Date(value);
  const s = String(value ?? '').trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, d] = s.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    return Number.isNaN(dt.getTime()) ? null : dt;
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t);
}

export function dateInput(date = new Date()) {
  const d = parseDate(date) || new Date();
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

export function addDays(date, days) {
  const d = parseDate(date) || new Date();
  d.setDate(d.getDate() + Number(days || 0));
  return d;
}
export function addMonths(date, months) {
  const d = parseDate(date) || new Date();
  const day = d.getDate();
  const next = new Date(d.getFullYear(), d.getMonth() + Number(months || 0), 1);
  const last = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
  next.setDate(Math.min(day, last));
  return next;
}
export function dayKey(date) { return dateInput(date); }

export function startOfDay(date) {
  const d = parseDate(date) || new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
export function endOfDay(date) {
  const d = parseDate(date) || new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
}
export function startOfWeek(date) {
  const d = startOfDay(date);
  d.setDate(d.getDate() - d.getDay());
  return d;
}
export function startOfMonth(date) {
  const d = parseDate(date) || new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
export function endOfMonth(date) {
  const d = parseDate(date) || new Date();
  return new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
}

export function monthMatrix(cursor = new Date()) {
  const start = startOfWeek(startOfMonth(cursor));
  return Array.from({ length: 42 }, (_, i) => {
    const date = addDays(start, i);
    return { date, key: dayKey(date), inMonth: date.getMonth() === startOfMonth(cursor).getMonth() && date.getFullYear() === startOfMonth(cursor).getFullYear() };
  });
}
export function weekDays(cursor = new Date()) {
  const start = startOfWeek(cursor);
  return Array.from({ length: 7 }, (_, i) => {
    const date = addDays(start, i);
    return { date, key: dayKey(date), inMonth: date.getMonth() === start.getMonth() };
  });
}

export function eventStart(event) { return parseDate(event?.start || event?.date) || new Date(NaN); }
export function eventEnd(event) {
  const start = eventStart(event);
  const explicit = parseDate(event?.end);
  if (!explicit) return new Date(start.getTime() + (event?.allDay ? 86400000 : 3600000));
  if (explicit.getTime() <= start.getTime()) return event?.allDay ? new Date(start.getTime() + 86400000) : new Date(start.getTime() + 3600000);
  return explicit;
}
export function eventRange(event) {
  const start = eventStart(event);
  const end = eventEnd(event);
  return Number.isNaN(start.getTime()) ? null : { start, end };
}
export function overlaps(event, from, to) {
  const range = eventRange(event);
  if (!range) return false;
  return range.start.getTime() < to.getTime() && range.end.getTime() > from.getTime();
}

export function timeLabel(value, timeZone = 'auto') {
  const d = parseDate(value);
  if (!d || Number.isNaN(d.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('en-US', {
      hour: 'numeric', minute: '2-digit',
      timeZone: timeZone && timeZone !== 'auto' ? timeZone : undefined,
    }).format(d);
  } catch {
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }
}

export function dateLabel(value, opts = {}) {
  const d = parseDate(value);
  if (!d || Number.isNaN(d.getTime())) return String(value ?? '');
  return d.toLocaleDateString('en-US', {
    weekday: opts.weekday ? 'short' : undefined,
    month: opts.month || 'short', day: 'numeric',
    year: opts.year ? 'numeric' : undefined,
  });
}

export function monthTitle(date) {
  const d = parseDate(date) || new Date();
  return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}
export function weekTitle(date) {
  const days = weekDays(date);
  const first = days[0].date, last = days[6].date;
  const f = first.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const l = last.toLocaleDateString('en-US', { month: first.getMonth() === last.getMonth() ? undefined : 'short', day: 'numeric', year: 'numeric' });
  return `${f} – ${l}`;
}
export function timeZoneLabel(value) {
  if (!value || value === 'auto') {
    try { return `Local · ${Intl.DateTimeFormat().resolvedOptions().timeZone || 'device'}`; } catch { return 'Local · device'; }
  }
  return value;
}
