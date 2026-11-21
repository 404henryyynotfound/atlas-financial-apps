/* Dependency-free SVG charts for Tandem. Every chart returns markup only;
   no external library, no network call, no runtime dependency. */
import { esc, num } from './utils.js';

let chartSeq = 0;

export function donut(segments, opts = {}) {
  const size = opts.size || 180;
  const thickness = opts.thickness || 18;
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  const clean = (segments || []).filter(s => Math.abs(Number(s.value) || 0) > 0);
  const total = clean.reduce((s, x) => s + Math.abs(Number(x.value)), 0) || 1;
  let offset = 0;
  const rings = clean.map(seg => {
    const len = Math.abs(Number(seg.value)) / total * circumference;
    const pct = (len / circumference * 100).toFixed(1);
    const ring = `<circle cx="${size / 2}" cy="${size / 2}" r="${radius}" fill="none" stroke="${esc(seg.color || '#e9685a')}" stroke-width="${thickness}"
      stroke-dasharray="${Math.max(len - 3, 0).toFixed(2)} ${circumference.toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}"
      transform="rotate(-90 ${size / 2} ${size / 2})" stroke-linecap="round"><title>${esc(seg.label)}: ${pct}%</title></circle>`;
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
  const clean = (items || []).filter(i => i && Number.isFinite(Number(i.value)));
  if (!clean.length) return '<div class="chart-empty">Nothing to compare yet.</div>';
  const max = Math.max(...clean.map(i => Math.abs(Number(i.value) || 0)), 0.0001);
  return `<div class="bar-list">${clean.map(i => `
    <div class="bar-row">
      <span class="bar-label" title="${esc(i.label)}">${esc(i.label)}</span>
      <div class="bar-track"><span style="width:${(Math.abs(Number(i.value) || 0) / max * 100).toFixed(1)}%;background:${esc(i.color || '#e9685a')}"></span></div>
      <span class="bar-value">${esc(i.display ?? num(i.value, 0))}</span>
    </div>`).join('')}</div>`;
}

/* Vertical SVG bars — useful for month-by-month expense totals. */
export function columnChart(items, opts = {}) {
  const clean = (items || []).filter(i => i && Number.isFinite(Number(i.value)));
  if (!clean.length) return '<div class="chart-empty">No data yet — record an expense to see the trend.</div>';
  const id = `tandem-chart-${++chartSeq}`;
  const w = 720, h = opts.height || 230;
  const left = 12, right = 12, top = 26, bottom = 40;
  const plotH = h - top - bottom;
  const slot = (w - left - right) / clean.length;
  const barW = Math.min(slot * 0.6, 62);
  const max = Math.max(...clean.map(i => Math.abs(Number(i.value) || 0)), 1);
  const color = opts.color || '#e9685a';
  const grid = [0, 0.5, 1].map(f => {
    const y = (top + plotH - plotH * f).toFixed(1);
    return `<line x1="${left}" x2="${w - right}" y1="${y}" y2="${y}" class="chart-grid"/>`;
  }).join('');
  const cols = clean.map((item, i) => {
    const v = Math.max(0, Number(item.value) || 0);
    const bh = Math.max(2, v / max * plotH);
    const x = left + slot * i + (slot - barW) / 2;
    const y = top + plotH - bh;
    const label = String(item.label || '').slice(0, 10);
    return `<g>
      <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${bh.toFixed(1)}" rx="6" fill="${esc(item.color || color)}" opacity=".92">
        <title>${esc(item.label)}: ${esc(item.display ?? num(v, 2))}</title>
      </rect>
      <text x="${(x + barW / 2).toFixed(1)}" y="${(y - 8).toFixed(1)}" text-anchor="middle" class="chart-value">${esc(item.display ?? num(v, 0))}</text>
      <text x="${(x + barW / 2).toFixed(1)}" y="${(h - 12).toFixed(1)}" text-anchor="middle" class="chart-label">${esc(label)}</text>
    </g>`;
  }).join('');
  return `<div class="chart-wrap column-chart">
    <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${esc(opts.label || 'Bar chart')}">
      <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${color}" stop-opacity=".22"/><stop offset="100%" stop-color="${color}" stop-opacity="0"/>
      </linearGradient></defs>
      ${grid}${cols}
    </svg>
  </div>`;
}
