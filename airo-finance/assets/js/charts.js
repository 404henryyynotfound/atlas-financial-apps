/* Dependency-free SVG charts. Each chart returns markup; attachChartHover
   wires up the pointer crosshair after the view is painted. */
import { esc, money, num } from './utils.js';

let chartSeq = 0;

function pointsFrom(series, w, h, pad = 10) {
  const values = series.map(p => Number(p.value ?? p.close) || 0);
  const min = Math.min(...values), max = Math.max(...values);
  const span = max - min || Math.max(Math.abs(max) * 0.01, 1);
  const lo = min - span * 0.14, hi = max + span * 0.14;
  const coords = series.map((p, i) => ({
    x: pad + (i / Math.max(series.length - 1, 1)) * (w - pad * 2),
    y: h - pad - ((values[i] - lo) / (hi - lo || 1)) * (h - pad * 2),
    value: values[i], label: p.date || p.label || '',
  }));
  return { coords, min: lo, max: hi };
}

export function lineChart(series, opts = {}) {
  const id = `airo-chart-${++chartSeq}`;
  const w = 800, h = opts.height || 240;
  if (!Array.isArray(series) || !series.length) return '<div class="chart-empty">No data yet — add a transaction to see the trend.</div>';
  const { coords } = pointsFrom(series, w, h);
  const line = coords.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ');
  const area = `${line} L${coords[coords.length - 1].x.toFixed(2)},${h} L${coords[0].x.toFixed(2)},${h} Z`;
  const color = opts.color || '#3b82f6';
  const grid = [0.25, 0.5, 0.75].map(f => `<line x1="0" x2="${w}" y1="${(h * f).toFixed(1)}" y2="${(h * f).toFixed(1)}" class="chart-grid"/>`).join('');
  const labels = [coords[0], coords[Math.floor(coords.length / 2)], coords[coords.length - 1]]
    .map((p, i) => `<text x="${Math.min(Math.max(p.x, 30), w - 30)}" y="${h - 2}" text-anchor="${i === 0 ? 'start' : i === 2 ? 'end' : 'middle'}" class="chart-label">${esc(p.label)}</text>`)
    .join('');
  const pointData = coords.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)},${p.value.toFixed(2)},${p.label}`).join(';');
  return `<div class="chart-wrap" data-chart data-points="${esc(pointData)}" data-currency="${esc(opts.currency || '')}">
    <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="${esc(opts.label || 'Trend chart')}">
      <defs><linearGradient id="${id}-fill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${color}" stop-opacity="0.28"/>
        <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
      </linearGradient></defs>
      ${grid}
      <path d="${area}" fill="url(#${id}-fill)"/>
      <path d="${line}" fill="none" stroke="${color}" stroke-width="2.4" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/>
      <line x1="0" x2="${w}" y1="${coords[coords.length - 1].y.toFixed(1)}" y2="${coords[coords.length - 1].y.toFixed(1)}" class="chart-last-line"/>
      ${labels}
    </svg>
    <div class="chart-crosshair" hidden></div><div class="chart-tip" hidden></div>
  </div>`;
}

export function donut(segments, opts = {}) {
  const size = opts.size || 180, thickness = opts.thickness || 18;
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  const clean = (segments || []).filter(s => Math.abs(Number(s.value) || 0) > 0);
  const total = clean.reduce((s, x) => s + Math.abs(Number(x.value)), 0) || 1;
  let offset = 0;
  const rings = clean.map(seg => {
    const len = Math.abs(Number(seg.value)) / total * circumference;
    const ring = `<circle cx="${size / 2}" cy="${size / 2}" r="${radius}" fill="none" stroke="${esc(seg.color || '#3b82f6')}" stroke-width="${thickness}"
      stroke-dasharray="${Math.max(len - 3, 0).toFixed(2)} ${circumference.toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}"
      transform="rotate(-90 ${size / 2} ${size / 2})" stroke-linecap="round"><title>${esc(seg.label)}: ${(len / circumference * 100).toFixed(1)}%</title></circle>`;
    offset += len;
    return ring;
  }).join('');
  return `<div class="donut" style="width:${size}px;height:${size}px">
    <svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="${esc(opts.label || 'Breakdown')}">
      <circle cx="${size / 2}" cy="${size / 2}" r="${radius}" fill="none" stroke="var(--line)" stroke-width="${thickness}"/>
      ${rings}
    </svg>
    <div class="donut-center"><span>${esc(opts.label || '')}</span><strong>${esc(opts.value || '')}</strong></div>
  </div>`;
}

export function bars(items, opts = {}) {
  if (!Array.isArray(items) || !items.length) return '<div class="chart-empty">Nothing to compare yet.</div>';
  const max = Math.max(...items.map(i => Math.abs(Number(i.value) || 0)), 1);
  return `<div class="bar-list">${items.map(i => `
    <div class="bar-row">
      <span class="bar-label" title="${esc(i.label)}">${esc(i.label)}</span>
      <div class="bar-track"><span style="width:${(Math.abs(Number(i.value) || 0) / max * 100).toFixed(1)}%;background:${esc(i.color || '#3b82f6')}"></span></div>
      <span class="bar-value">${esc(i.display ?? num(i.value, 0))}</span>
    </div>`).join('')}</div>`;
}

export function attachChartHover(root) {
  root.querySelectorAll('[data-chart]').forEach(el => {
    if (el.dataset.bound) return;
    el.dataset.bound = '1';
    const tip = el.querySelector('.chart-tip');
    const cross = el.querySelector('.chart-crosshair');
    const points = String(el.dataset.points || '').split(';').filter(Boolean).map(s => {
      const [x, y, value, label] = s.split(',');
      return { x: Number(x), y: Number(y), value: Number(value), label };
    });
    const currency = el.dataset.currency;
    if (!points.length) return;
    el.addEventListener('mousemove', e => {
      const rect = el.getBoundingClientRect();
      if (!rect.width) return;
      const rel = (e.clientX - rect.left) / rect.width * 800;
      const p = points.reduce((best, cur) => Math.abs(cur.x - rel) < Math.abs(best.x - rel) ? cur : best, points[0]);
      if (!p) return;
      tip.hidden = false; cross.hidden = false;
      tip.style.left = `${Math.min(Math.max(p.x / 800 * rect.width, 52), rect.width - 52)}px`;
      tip.style.top = `${Math.max(p.y / 240 * rect.height - 54, 2)}px`;
      cross.style.left = `${p.x / 800 * rect.width}px`;
      const value = currency ? money(p.value, currency) : num(p.value, 2);
      tip.innerHTML = `<strong>${esc(value)}</strong><span>${esc(p.label || '')}</span>`;
    });
    el.addEventListener('mouseleave', () => { tip.hidden = true; cross.hidden = true; });
  });
}
