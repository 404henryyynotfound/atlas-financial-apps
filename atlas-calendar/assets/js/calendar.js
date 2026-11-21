/* Calendar engine: normalization, merging, range math and view markup.
   Pure functions only — the controller in app.js owns all interactions. */
import {
  TYPES, TYPE_IDS, TYPE_MAP, WEEKDAYS, HOURS, HOUR_HEIGHT, APP_LINKS, APP_LABELS,
} from './config.js';
import {
  esc, safeType, safeHref, parseDate, dateInput, dayKey, addDays, startOfDay, endOfDay,
  monthMatrix, weekDays, eventStart, eventEnd, overlaps, timeLabel, dateLabel,
  monthTitle, weekTitle, clamp,
} from './utils.js';

export function appSlugOf(value) {
  const raw = String(value || '').toLowerCase().replace(/\s+/g, '-');
  return raw.split(':')[0] || 'calendar';
}

export function appLabelOf(value) {
  const slug = appSlugOf(value);
  return APP_LABELS[slug] || slug.replace(/(^|-)\w/g, s => s.replace('-', ' ').toUpperCase());
}

export function normalizeEvent(raw = {}, { derived = false } = {}) {
  const start = String(raw.start || raw.date || '');
  const end = String(raw.end || '');
  const title = String(raw.title || raw.name || (derived ? 'Derived event' : 'Untitled event'));
  const slug = appSlugOf(raw.app || raw.sourcePrefix || 'calendar');
  const sourceId = String(raw.sourceId || raw.externalId || raw.id || '');
  const key = sourceId || `${title.trim().toLowerCase()}|${start}`;
  const fallbackHref = slug === 'calendar' ? '' : (APP_LINKS[slug] || '');
  const href = safeHref(raw.href || raw.url || raw.link) || fallbackHref;
  return {
    _key: key,
    id: String(raw.id || raw._localId || sourceId || key),
    sourceId,
    title,
    start,
    end,
    allDay: !!raw.allDay,
    description: String(raw.description || raw.notes || ''),
    location: String(raw.location || ''),
    category: String(raw.category || 'General'),
    type: safeType(raw.type),
    app: slug,
    appLabel: appLabelOf(slug),
    href,
    derived: derived || !!raw.derived || (slug !== 'calendar' && !raw.manual),
    sourcePrefix: String(raw.sourcePrefix || ''),
    raw,
  };
}

export function mergeEvents(manual = [], derived = []) {
  const seen = new Map();
  const out = [];
  function add(raw, isDerived) {
    const event = { ...normalizeEvent(raw, { derived: isDerived }), derived: isDerived };
    const titleStart = `${event.title.trim().toLowerCase()}|${event.start}`;
    const keys = [...(event.sourceId ? [`id:${event.sourceId}`] : []), `ts:${titleStart}`];
    if (keys.some(k => seen.has(k))) return;
    out.push(event);
    keys.forEach(k => seen.set(k, event));
  }
  manual.forEach(e => add(e, false));   // manual events win over derived copies
  derived.forEach(e => add(e, true));
  return out.sort((a, b) => {
    const sa = eventStart(a).getTime(), sb = eventStart(b).getTime();
    if (Number.isNaN(sa)) return 1;
    if (Number.isNaN(sb)) return -1;
    return sa - sb || a.title.localeCompare(b.title);
  });
}

export function filterEvents(events, { filterType = 'all', hiddenTypes = [] } = {}) {
  const hidden = new Set(hiddenTypes);
  return events.filter(e => {
    if (hidden.has(e.type)) return false;
    return filterType === 'all' || e.type === filterType;
  });
}

export function eventsInRange(events, from, to) {
  return events.filter(e => overlaps(e, from, to));
}

export function typeCounts(events) {
  const counts = { all: events.length, personal: 0, family: 0, business: 0, developer: 0 };
  events.forEach(e => { if (TYPE_IDS.includes(e.type)) counts[e.type] += 1; });
  return counts;
}

export function eventTimeLabel(event, timeZone = 'auto') {
  if (event.allDay) return 'All day';
  const s = eventStart(event);
  const e = eventEnd(event);
  if (Number.isNaN(s.getTime())) return '';
  const start = timeLabel(s, timeZone);
  const end = timeLabel(e, timeZone);
  return end && end !== start ? `${start} – ${end}` : start;
}

function classFor(event) { return `type-${safeType(event.type)}`; }

export function eventPill(event, timeZone = 'auto', compact = false) {
  const time = event.allDay ? '' : `<span class="pill-time">${esc(timeLabel(eventStart(event), timeZone))}</span>`;
  const badge = event.derived ? '<span class="derived-mark" title="From another Atlas app">↗</span>' : '';
  return `<button type="button" class="event-pill ${classFor(event)}${event.derived ? ' is-derived' : ''}" data-action="event-detail" data-id="${esc(event.id)}"
    aria-label="Open ${esc(event.title)}" title="${esc(event.title)} — ${esc(eventTimeLabel(event, timeZone))}">
    <span class="pill-dot"></span>${compact ? '' : time}<span class="pill-title">${esc(event.title)}</span>${badge}
  </button>`;
}

export function renderMonth({ cursor, events, timeZone = 'auto' } = {}) {
  const cells = monthMatrix(cursor);
  const today = dateInput();
  const byDay = new Map();
  events.forEach(event => {
    const start = eventStart(event);
    if (Number.isNaN(start.getTime())) return;
    const end = eventEnd(event);
    // Multi-day events appear on every day they touch (capped to 10 days).
    let day = startOfDay(start);
    const last = startOfDay(end);
    let guard = 0;
    while (day <= last && guard < 10) {
      const key = dayKey(day);
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(event);
      day = addDays(day, 1);
      guard += 1;
    }
  });
  const head = WEEKDAYS.map(d => `<div class="weekday" role="columnheader">${d}</div>`).join('');
  const body = cells.map(cell => {
    const rows = (byDay.get(cell.key) || []).slice().sort((a, b) => Number(a.allDay ? 0 : 1) - Number(b.allDay ? 0 : 1) || eventStart(a) - eventStart(b));
    const shown = rows.slice(0, 3).map(e => eventPill(e, timeZone, true)).join('');
    const more = rows.length > 3 ? `<button type="button" class="more-link" data-action="open-day" data-date="${esc(cell.key)}">+${rows.length - 3} more</button>` : '';
    return `<div class="day-cell ${cell.inMonth ? '' : 'outside'} ${cell.key === today ? 'today' : ''}" role="gridcell" data-action="open-day" data-date="${esc(cell.key)}" aria-label="${esc(dateLabel(cell.date, { weekday: true, year: true }))}, ${rows.length} events">
      <div class="day-head"><span class="day-num">${cell.date.getDate()}</span>
        <button type="button" class="day-add" data-action="new-event" data-date="${esc(cell.key)}" aria-label="Add event on ${esc(dateLabel(cell.date, { weekday: true }))}">+</button>
      </div>
      <div class="day-events">${shown}${more}</div>
    </div>`;
  }).join('');
  return `<div class="month-wrap"><div class="month-grid" role="grid" aria-label="${esc(monthTitle(cursor))}">${head}${body}</div></div>`;
}

function hourLabel(hour, timeZone) {
  const d = new Date(2020, 0, 1, hour, 0, 0);
  return timeLabel(d, timeZone);
}

export function renderWeek({ cursor, events, timeZone = 'auto' } = {}) {
  const days = weekDays(cursor);
  const today = dateInput();
  const totalHeight = (HOURS.length) * HOUR_HEIGHT;
  const head = `<div class="week-corner"><span>Time</span></div>${days.map(day => `
    <div class="week-day-head ${day.key === today ? 'today' : ''}">
      <span>${WEEKDAYS[day.date.getDay()]}</span>
      <strong>${day.date.getDate()}</strong>
      <button type="button" class="day-add" data-action="new-event" data-date="${esc(day.key)}" aria-label="Add event on ${esc(dateLabel(day.date, { weekday: true }))}">+</button>
    </div>`).join('')}`;
  const allDay = days.map(day => {
    const rows = events.filter(e => e.allDay && overlaps(e, startOfDay(day.date), endOfDay(day.date)));
    return `<div class="week-allday-cell" data-action="open-day" data-date="${esc(day.key)}">${rows.map(e => eventPill(e, timeZone, true)).join('')}</div>`;
  }).join('');
  const hourLabels = HOURS.map((h, i) => `<div class="hour-label" style="top:${i * HOUR_HEIGHT}px">${esc(hourLabel(h, timeZone))}</div>`).join('');
  const cols = days.map(day => {
    const from = startOfDay(day.date), to = endOfDay(day.date);
    const timed = events.filter(e => !e.allDay && overlaps(e, from, to));
    const blocks = timed.map(e => {
      const s = eventStart(e), en = eventEnd(e);
      const visibleStart = Math.max(s.getTime(), from.getTime());
      const visibleEnd = Math.min(en.getTime(), to.getTime());
      const dayStart = new Date(day.date.getFullYear(), day.date.getMonth(), day.date.getDate(), HOURS[0], 0, 0).getTime();
      const dayEnd = dayStart + totalHeight / HOUR_HEIGHT * 3600000;
      if (visibleEnd <= dayStart || visibleStart >= dayEnd) return '';
      const clippedStart = Math.max(visibleStart, dayStart);
      const clippedEnd = Math.min(visibleEnd, dayEnd);
      const top = clamp((clippedStart - dayStart) / 3600000 * HOUR_HEIGHT, 0, totalHeight - 26);
      const height = clamp((clippedEnd - clippedStart) / 3600000 * HOUR_HEIGHT, 26, totalHeight - top);
      return `<button type="button" class="week-event ${classFor(e)}${e.derived ? ' is-derived' : ''}" style="top:${top.toFixed(1)}px;height:${height.toFixed(1)}px"
        data-action="event-detail" data-id="${esc(e.id)}" title="${esc(e.title)} — ${esc(eventTimeLabel(e, timeZone))}">
        <strong>${esc(e.title)}</strong><span>${esc(timeLabel(s, timeZone))}${e.derived ? ' · derived' : ''}</span>
      </button>`;
    }).join('');
    return `<div class="week-col ${day.key === today ? 'today' : ''}" data-action="open-day" data-date="${esc(day.key)}">${blocks}</div>`;
  }).join('');
  return `<div class="week-wrap">
    <div class="week-header">${head}</div>
    <div class="week-allday"><div class="week-gutter">all-day</div>${allDay}</div>
    <div class="week-scroll" style="--hour-height:${HOUR_HEIGHT}px;--week-height:${totalHeight}px">
      <div class="week-hours">${hourLabels}</div><div class="week-cols">${cols}</div>
    </div>
  </div>`;
}

export function renderAgenda({ events, timeZone = 'auto' } = {}) {
  if (!events.length) return '';
  const groups = new Map();
  events.forEach(e => {
    const key = dayKey(eventStart(e));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  });
  return [...groups.entries()].map(([key, rows]) => {
    const date = parseDate(key);
    return `<section class="agenda-group">
      <div class="agenda-date"><strong>${esc(dateLabel(date, { weekday: true, year: true }))}</strong><span>${rows.length} ${rows.length === 1 ? 'event' : 'events'}</span></div>
      <div class="agenda-rows">${rows.map(e => `
        <button type="button" class="agenda-row ${classFor(e)}${e.derived ? ' is-derived' : ''}" data-action="event-detail" data-id="${esc(e.id)}">
          <span class="agenda-time">${esc(eventTimeLabel(e, timeZone))}</span>
          <span class="agenda-bar"></span>
          <span class="agenda-main"><strong>${esc(e.title)}</strong>
            <span class="agenda-meta">${esc(e.category || 'General')}${e.location ? ` · ${esc(e.location)}` : ''}${e.derived ? ` · from ${esc(e.appLabel)}` : ''}</span>
          </span>
          <span class="agenda-type">${esc(TYPE_MAP[e.type]?.label || e.type)}</span>
          <span class="agenda-arrow">›</span>
        </button>`).join('')}</div>
    </section>`;
  }).join('');
}

export function renderUpcoming(events, { days = 7, timeZone = 'auto' } = {}) {
  const today = startOfDay(new Date());
  const end = endOfDay(addDays(today, days - 1));
  const rows = eventsInRange(events, today, end).slice(0, 12);
  if (!rows.length) return '';
  return rows.map(e => `
    <button type="button" class="upcoming-row ${classFor(e)}" data-action="event-detail" data-id="${esc(e.id)}">
      <span class="up-when">${esc(dateLabel(eventStart(e), { weekday: true }))}<small>${e.allDay ? 'All day' : esc(timeLabel(eventStart(e), timeZone))}</small></span>
      <span class="up-dot"></span>
      <span class="up-main"><strong>${esc(e.title)}</strong><small>${esc(e.derived ? `from ${e.appLabel}` : e.category || 'Personal')}</small></span>
      <span class="up-arrow">›</span>
    </button>`).join('');
}

export function renderDerivedList(events, { limit = 5, timeZone = 'auto' } = {}) {
  const rows = events.filter(e => e.derived).slice(0, limit);
  if (!rows.length) return '';
  return rows.map(e => {
    const target = e.href || APP_LINKS[e.app] || '';
    const inner = `<span class="derived-date">${esc(dateLabel(eventStart(e), { weekday: true }))}</span>
      <span class="derived-main"><strong>${esc(e.title)}</strong><small>${esc(e.appLabel)} · ${esc(eventTimeLabel(e, timeZone))}</small></span>
      <span class="derived-go">${target ? 'Open ↗' : 'Derived'}</span>`;
    return target
      ? `<a class="derived-row ${classFor(e)}" href="${esc(target)}" target="_blank" rel="noopener noreferrer">${inner}</a>`
      : `<div class="derived-row ${classFor(e)}">${inner}</div>`;
  }).join('');
}

export function typeBadge(type) {
  const info = TYPE_MAP[type] || TYPE_MAP.personal;
  return `<span class="type-badge ${classFor(info)}">${esc(info.label)}</span>`;
}

export function rangeForCursor(cursor) {
  const first = startOfDay(new Date(parseDate(cursor) || new Date()));
  const monthStart = new Date(first.getFullYear(), first.getMonth(), 1);
  const monthEnd = new Date(first.getFullYear(), first.getMonth() + 1, 0, 23, 59, 59, 999);
  return {
    from: dateInput(addDays(monthStart, -14)),
    to: dateInput(addDays(monthEnd, 45)),
  };
}

export function weekRangeLabel(cursor) { return weekTitle(cursor); }
