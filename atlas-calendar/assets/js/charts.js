/* Tiny dependency-free SVG charts for Atlas Calendar. Markup only. */
import { CHART_COLORS, TYPES } from './config.js';
import { esc, dayKey, addDays, startOfDay, eventStart, eventEnd, dateLabel } from './utils.js';

/* Event density over a rolling window: one bar per day, stacked by type. */
export function densityChart(events = [], { days = 14, from, height = 150 } = {}) {
  const start = startOfDay(from ? new Date(`${String(from).slice(0, 10)}T00:00:00`) : new Date());
  const buckets = Array.from({ length: days }, (_, i) => {
    const date = addDays(start, i);
    return { key: dayKey(date), date, personal: 0, family: 0, business: 0, developer: 0 };
  });
  events.forEach(e => {
    const s = eventStart(e), en = eventEnd(e);
    if (Number.isNaN(s.getTime())) return;
    const first = startOfDay(s), last = startOfDay(en);
    let day = first, guard = 0;
    while (day <= last && guard < 10) {
      const bucket = buckets.find(b => b.key === dayKey(day));
      if (bucket && TYPES.some(t => t.id === e.type)) bucket[e.type] += 1;
      day = addDays(day, 1); guard += 1;
    }
  });
  const max = Math.max(1, ...buckets.map(b => b.personal + b.family + b.business + b.developer));
  const w = 720, pad = 10, barW = (w - pad * 2) / days;
  const grid = [0.25, 0.5, 0.75, 1].map(f => {
    const y = (height - 26) - f * (height - 42);
    return `<line x1="0" x2="${w}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" class="density-grid"/>`;
  }).join('');
  const bars = buckets.map((b, i) => {
    const x = pad + i * barW;
    let cursor = height - 26;
    const parts = TYPES.map(t => {
      const value = b[t.id];
      if (!value) return '';
      const h = value / max * (height - 42);
      cursor -= h;
      return `<rect x="${(x + 2).toFixed(1)}" y="${cursor.toFixed(1)}" width="${Math.max(barW - 4, 2).toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${CHART_COLORS[t.id]}"><title>${esc(dateLabel(b.date))} · ${esc(t.label)}: ${value}</title></rect>`;
    }).join('');
    return `<g>${parts}<rect x="${x.toFixed(1)}" y="${height - 26}" width="${Math.max(barW - 4, 2).toFixed(1)}" height="${TYPES.reduce((n, t) => n + b[t.id], 0) ? 1.5 : 0}" fill="var(--line-strong)"/></g>`;
  }).join('');
  const labels = buckets.filter((_, i) => i === 0 || i === Math.floor(days / 2) || i === days - 1)
    .map(b => {
      const i = buckets.indexOf(b);
      const x = pad + i * barW;
      return `<text x="${(x + barW / 2).toFixed(1)}" y="${height - 6}" text-anchor="middle" class="density-label">${esc(dateLabel(b.date, { month: 'short' }))}</text>`;
    }).join('');
  const total = buckets.reduce((n, b) => n + TYPES.reduce((m, t) => m + b[t.id], 0), 0);
  return `<div class="density-wrap" role="img" aria-label="Event density chart, ${total} events across ${days} days">
    <svg viewBox="0 0 ${w} ${height}" preserveAspectRatio="none" aria-hidden="true">${grid}${bars}${labels}</svg>
  </div>`;
}

export function typeLegend(counts) {
  return `<div class="chart-legend">${TYPES.map(t => `
    <span class="legend-item type-${t.id}"><i></i>${esc(t.label)} <b>${Number(counts?.[t.id]) || 0}</b></span>`).join('')}</div>`;
}
