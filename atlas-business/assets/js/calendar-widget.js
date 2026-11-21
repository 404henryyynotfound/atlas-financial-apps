/* Atlas Business — derived calendar widget.
   Self-contained: no dependencies, no shared host state and no hardcoded sync
   endpoint. Endpoint and token readers are supplied by the host app and called
   afresh for every load so sign-in / endpoint changes are picked up. */

const CALENDAR_HOME = 'https://atlas-calendar.surge.sh';
const CALENDAR_OVERVIEW = `${CALENDAR_HOME}/#/app/overview`;
const STYLE_ID = 'atlas-cal-widget-styles';
const SIGN_IN_MESSAGE = 'Sign in to Atlas Sync to see dates from your other apps';
const STREAM_CHECK_MS = 30000;

const CSS = `
.atlas-cal-widget {
  position: fixed;
  right: 18px;
  bottom: 18px;
  /* Above app chrome, below modals (100) and toasts (200). */
  z-index: 70;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 10px;
  color: currentColor;
  font: 500 13px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
.atlas-cal-widget *, .atlas-cal-widget *::before, .atlas-cal-widget *::after { box-sizing: border-box; }
.atlas-cal-widget button, .atlas-cal-widget a { color: currentColor; font: inherit; }
.atlas-cal-widget__launcher {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 9px 15px;
  border: 1px solid rgba(127, 127, 127, .42);
  border-color: color-mix(in srgb, currentColor 24%, transparent);
  border-radius: 999px;
  background: rgba(128, 128, 128, .12);
  background: color-mix(in srgb, currentColor 12%, transparent);
  box-shadow: 0 10px 28px rgba(0, 0, 0, .22);
  cursor: pointer;
  backdrop-filter: blur(8px);
  transition: transform .16s ease, background .16s ease;
}
.atlas-cal-widget__launcher:hover {
  transform: translateY(-1px);
  background: color-mix(in srgb, currentColor 18%, transparent);
}
.atlas-cal-widget__launcher-icon { font-size: 16px; line-height: 1; }
.atlas-cal-widget__launcher:focus-visible,
.atlas-cal-widget__icon-btn:focus-visible,
.atlas-cal-widget__item:focus-visible,
.atlas-cal-widget__link:focus-visible,
.atlas-cal-widget__retry:focus-visible {
  outline: 2px solid currentColor;
  outline-offset: 2px;
}
.atlas-cal-widget__panel {
  display: flex;
  flex-direction: column;
  width: min(348px, calc(100vw - 36px));
  max-height: min(440px, calc(100vh - 110px));
  overflow: hidden;
  border: 1px solid rgba(127, 127, 127, .42);
  border-color: color-mix(in srgb, currentColor 24%, transparent);
  border-radius: 14px;
  background: rgba(128, 128, 128, .12);
  background: color-mix(in srgb, currentColor 6%, rgba(128, 128, 128, .08));
  box-shadow: 0 20px 50px rgba(0, 0, 0, .3);
  backdrop-filter: blur(14px);
}
.atlas-cal-widget__panel[hidden] { display: none; }
.atlas-cal-widget__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  padding: 13px 12px 11px 14px;
  border-bottom: 1px solid rgba(127, 127, 127, .32);
  border-color: color-mix(in srgb, currentColor 16%, transparent);
}
.atlas-cal-widget__heading { display: grid; gap: 2px; min-width: 0; }
.atlas-cal-widget__heading strong { font-size: 14px; letter-spacing: .01em; }
.atlas-cal-widget__status { font-size: 11px; opacity: .68; }
.atlas-cal-widget__actions { display: flex; gap: 4px; }
.atlas-cal-widget__icon-btn {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  cursor: pointer;
  opacity: .8;
}
.atlas-cal-widget__icon-btn:hover:not(:disabled) {
  background: color-mix(in srgb, currentColor 10%, transparent);
  opacity: 1;
}
.atlas-cal-widget__icon-btn:disabled { opacity: .38; cursor: default; }
.atlas-cal-widget__list {
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  padding: 6px;
}
.atlas-cal-widget__item {
  display: grid;
  grid-template-columns: 50px minmax(0, 1fr) 12px;
  align-items: start;
  gap: 9px;
  padding: 9px 8px;
  border-radius: 9px;
  text-decoration: none;
}
.atlas-cal-widget__item + .atlas-cal-widget__item {
  border-top: 1px solid rgba(127, 127, 127, .28);
  border-color: color-mix(in srgb, currentColor 14%, transparent);
  border-radius: 0;
}
.atlas-cal-widget__item:hover { background: color-mix(in srgb, currentColor 8%, transparent); }
.atlas-cal-widget__date {
  display: grid;
  gap: 1px;
  justify-items: center;
  font-size: 10px;
  line-height: 1.2;
  opacity: .82;
}
.atlas-cal-widget__date b { font-size: 14px; font-weight: 700; }
.atlas-cal-widget__date small { font-size: 9px; opacity: .7; }
.atlas-cal-widget__item-main { display: grid; gap: 3px; min-width: 0; }
.atlas-cal-widget__item-top { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px; }
.atlas-cal-widget__item-top strong { font-size: 12.5px; font-weight: 700; overflow-wrap: anywhere; }
.atlas-cal-widget__badge {
  padding: 2px 5px;
  border: 1px solid rgba(127, 127, 127, .42);
  border-color: color-mix(in srgb, currentColor 24%, transparent);
  border-radius: 5px;
  font-size: 9px;
  font-weight: 800;
  letter-spacing: .06em;
  text-transform: uppercase;
  opacity: .82;
}
.atlas-cal-widget__badge--self { background: color-mix(in srgb, currentColor 14%, transparent); }
.atlas-cal-widget__item-desc { font-size: 11px; opacity: .66; overflow-wrap: anywhere; }
.atlas-cal-widget__item-arrow { font-size: 12px; opacity: .5; }
.atlas-cal-widget__state {
  display: grid;
  justify-items: center;
  gap: 7px;
  padding: 24px 16px;
  text-align: center;
}
.atlas-cal-widget__state-icon { font-size: 22px; line-height: 1; opacity: .7; }
.atlas-cal-widget__state strong { font-size: 13px; }
.atlas-cal-widget__state p { margin: 0; font-size: 11px; opacity: .68; }
.atlas-cal-widget__link, .atlas-cal-widget__retry {
  border: 0;
  border-bottom: 1px solid currentColor;
  border-radius: 0;
  background: transparent;
  padding: 0 0 1px;
  font-size: 11px;
  font-weight: 700;
  text-decoration: none;
  cursor: pointer;
  opacity: .9;
}
.atlas-cal-widget__foot {
  display: flex;
  justify-content: flex-end;
  padding: 9px 14px;
  border-top: 1px solid rgba(127, 127, 127, .32);
  border-color: color-mix(in srgb, currentColor 16%, transparent);
  font-size: 11px;
}
.atlas-cal-widget__foot a { text-decoration: none; opacity: .8; }
.atlas-cal-widget__foot a:hover { opacity: 1; text-decoration: underline; }
@media (max-width: 520px) {
  .atlas-cal-widget { right: 12px; bottom: 76px; }
  .atlas-cal-widget__panel {
    width: calc(100vw - 24px);
    max-height: min(56vh, 400px);
  }
}
@media (prefers-reduced-motion: reduce) {
  .atlas-cal-widget__launcher { transition: none; }
}
`;

/* ------------------------------- helpers -------------------------------- */

function asString(value) {
  if (value == null) return '';
  return String(value);
}

function escapeHtml(value) {
  return asString(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function readEndpoint(value) { return asString(value).trim().replace(/\/+$/, ''); }
function readToken(value) { return asString(value).trim(); }

function dateParts(value) {
  if (value == null || value === '') return null;
  const raw = asString(value).trim();
  if (!raw) return null;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);
  let date;
  try { date = new Date(dateOnly ? `${raw}T00:00:00` : raw); } catch { return null; }
  if (!date || Number.isNaN(date.getTime())) return null;
  const format = options => {
    try { return new Intl.DateTimeFormat(undefined, options).format(date); } catch { return ''; }
  };
  return {
    weekday: format({ weekday: 'short' }) || ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getDay()],
    dayMonth: format({ month: 'short', day: 'numeric' }) || `${date.getMonth() + 1}/${date.getDate()}`,
    year: String(date.getFullYear()),
    showYear: date.getFullYear() !== new Date().getFullYear(),
    time: dateOnly ? '' : format({ hour: 'numeric', minute: '2-digit' }),
    sort: date.getTime(),
  };
}

function eventDate(event) {
  return event.startAt || event.start || '';
}

function sortedEvents(events) {
  return events.slice().sort((a, b) => {
    const left = dateParts(eventDate(a))?.sort ?? Number.MAX_SAFE_INTEGER;
    const right = dateParts(eventDate(b))?.sort ?? Number.MAX_SAFE_INTEGER;
    return left - right;
  });
}

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

/* --------------------------------- widget -------------------------------- */

let sharedInstance = null;

export function initCalendarWidget({ app = '', getEndpoint, getToken } = {}) {
  if (sharedInstance?.root?.isConnected) return sharedInstance;
  injectStyles();

  const currentApp = asString(app).trim();
  const root = document.createElement('div');
  root.className = 'atlas-cal-widget';
  if (currentApp) root.dataset.app = currentApp;
  root.innerHTML = `
    <section class="atlas-cal-widget__panel" data-role="panel" role="dialog" aria-label="Derived calendar dates" hidden>
      <header class="atlas-cal-widget__head">
        <span class="atlas-cal-widget__heading">
          <strong>Calendar</strong>
          <small class="atlas-cal-widget__status" data-role="status">From your other Atlas apps</small>
        </span>
        <span class="atlas-cal-widget__actions">
          <button type="button" class="atlas-cal-widget__icon-btn" data-role="refresh" title="Refresh dates" aria-label="Refresh dates">↻</button>
          <button type="button" class="atlas-cal-widget__icon-btn" data-role="close" title="Close calendar" aria-label="Close calendar">✕</button>
        </span>
      </header>
      <div class="atlas-cal-widget__list" data-role="list" aria-live="polite"></div>
      <footer class="atlas-cal-widget__foot"><a href="${CALENDAR_OVERVIEW}" target="_blank" rel="noopener noreferrer">Open Atlas Calendar ↗</a></footer>
    </section>
    <button type="button" class="atlas-cal-widget__launcher" data-role="launcher" aria-expanded="false" aria-controls="atlas-cal-widget-panel" aria-label="${currentApp ? escapeHtml(`Calendar for ${currentApp}`) : 'Calendar'}">
      <span class="atlas-cal-widget__launcher-icon" aria-hidden="true">▦</span><span>Calendar</span>
    </button>`;
  document.body.appendChild(root);

  const ui = {
    panel: root.querySelector('[data-role="panel"]'),
    launcher: root.querySelector('[data-role="launcher"]'),
    refresh: root.querySelector('[data-role="refresh"]'),
    close: root.querySelector('[data-role="close"]'),
    status: root.querySelector('[data-role="status"]'),
    list: root.querySelector('[data-role="list"]'),
  };
  ui.panel.id = 'atlas-cal-widget-panel';

  let source = null;
  let streamKey = '';
  let requestSeq = 0;
  let checkTimer = null;
  let disposed = false;

  function config() {
    let endpoint = '';
    let token = '';
    try { endpoint = readEndpoint(getEndpoint?.()); } catch { /* reader failed */ }
    try { token = readToken(getToken?.()); } catch { /* reader failed */ }
    return { endpoint, token };
  }

  function renderState(title, message, { link = false, retry = false, icon = '⚠' } = {}) {
    ui.list.innerHTML = `<div class="atlas-cal-widget__state">
      <div class="atlas-cal-widget__state-icon" aria-hidden="true">${icon}</div>
      <strong>${escapeHtml(title)}</strong>
      ${message ? `<p>${escapeHtml(message)}</p>` : ''}
      ${link ? `<a class="atlas-cal-widget__link" href="${CALENDAR_HOME}" target="_blank" rel="noopener noreferrer">Open Atlas Calendar ↗</a>` : ''}
      ${retry ? '<button type="button" class="atlas-cal-widget__retry" data-role="retry">Try again</button>' : ''}
    </div>`;
  }

  function renderSignIn() {
    ui.status.textContent = 'Sign-in needed';
    renderState(SIGN_IN_MESSAGE, 'Dates from your other Atlas apps live in one calendar.', { link: true, icon: '↗' });
  }

  function renderEvent(raw) {
    const event = raw && typeof raw === 'object' ? raw : {};
    const title = asString(event.title).trim() || 'Untitled date';
    const eventApp = asString(event.app).trim() || 'atlas';
    const description = asString(event.description).trim();
    const sourceId = asString(event.sourceId).trim();
    const when = dateParts(eventDate(event));
    const date = when
      ? `<span class="atlas-cal-widget__date"><b>${escapeHtml(when.weekday)}</b><span>${escapeHtml(when.dayMonth)}</span>${when.showYear ? `<small>${escapeHtml(when.year)}</small>` : ''}</span>`
      : '<span class="atlas-cal-widget__date">—</span>';
    const badge = `<span class="atlas-cal-widget__badge${currentApp && eventApp.toLowerCase() === currentApp.toLowerCase() ? ' atlas-cal-widget__badge--self' : ''}"${sourceId ? ` title="${escapeHtml(sourceId)}"` : ''}>${escapeHtml(eventApp)}</span>`;
    const details = [
      description ? `<span class="atlas-cal-widget__item-desc">${escapeHtml(description)}</span>` : '',
      when?.time ? `<span class="atlas-cal-widget__item-desc">${escapeHtml(when.time)}</span>` : '',
    ].join('');
    return `<a class="atlas-cal-widget__item" href="${CALENDAR_OVERVIEW}" target="_blank" rel="noopener noreferrer">
      ${date}
      <span class="atlas-cal-widget__item-main"><span class="atlas-cal-widget__item-top"><strong>${escapeHtml(title)}</strong>${badge}</span>${details}</span>
      <span class="atlas-cal-widget__item-arrow" aria-hidden="true">↗</span>
    </a>`;
  }

  function renderEvents(events) {
    if (!events.length) {
      renderState('No derived dates yet', 'Deadlines from your other Atlas apps will appear here.', { link: true, icon: '▦' });
      return;
    }
    ui.list.innerHTML = sortedEvents(events).map(renderEvent).join('');
  }

  function stopStream() {
    if (source) {
      try { source.close(); } catch { /* noop */ }
      source = null;
    }
    streamKey = '';
  }

  function syncStream(endpoint, token) {
    if (!endpoint || !token || typeof EventSource === 'undefined') { stopStream(); return; }
    const nextKey = `${endpoint}\n${token}`;
    if (source && nextKey === streamKey) return;
    stopStream();
    try {
      source = new EventSource(`${endpoint}/api/events?token=${encodeURIComponent(token)}`);
      source.addEventListener('calendar', () => { load(); });
      streamKey = nextKey;
    } catch {
      stopStream();
    }
  }

  async function load() {
    if (disposed) return;
    const { endpoint, token } = config();
    syncStream(endpoint, token);

    if (!token) { stopStream(); renderSignIn(); return; }
    if (!endpoint) {
      stopStream();
      ui.status.textContent = 'Endpoint unavailable';
      renderState('Calendar unavailable', 'No Atlas Sync endpoint is configured for this app.', { retry: true });
      return;
    }

    const seq = ++requestSeq;
    ui.refresh.disabled = true;
    ui.status.textContent = 'Loading…';
    if (!ui.list.childElementCount) renderState('Loading dates…', 'Reading derived events from Atlas Sync.', { icon: '▦' });

    try {
      const res = await fetch(`${endpoint}/api/calendar/derived`, {
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
        cache: 'no-store',
      });
      if (seq !== requestSeq || disposed) return;
      if (res.status === 401 || res.status === 403) { renderSignIn(); return; }
      if (!res.ok) throw new Error(`Atlas Sync returned ${res.status}.`);
      const body = await res.json().catch(() => null);
      if (seq !== requestSeq || disposed) return;
      const events = Array.isArray(body) ? body : (Array.isArray(body?.events) ? body.events : []);
      renderEvents(events.filter(event => event && typeof event === 'object'));
      ui.status.textContent = events.length
        ? `${events.length} date${events.length === 1 ? '' : 's'} · live updates on`
        : 'No derived dates';
    } catch (error) {
      if (seq !== requestSeq || disposed) return;
      ui.status.textContent = 'Update failed';
      renderState('Couldn’t load dates', error?.message || 'Atlas Sync is unavailable right now.', { retry: true });
    } finally {
      if (seq === requestSeq) ui.refresh.disabled = false;
    }
  }

  function setOpen(open) {
    ui.panel.hidden = !open;
    ui.launcher.setAttribute('aria-expanded', String(open));
    if (open) load();
  }

  function resync() {
    if (disposed) return;
    const { endpoint, token } = config();
    syncStream(endpoint, token);
  }

  const onClickLauncher = () => setOpen(ui.panel.hidden);
  const onClickClose = () => { setOpen(false); ui.launcher.focus(); };
  const onClickRefresh = () => { load(); };
  const onListClick = event => {
    if (event.target.closest('[data-role="retry"]')) load();
  };
  const onKeydown = event => {
    if (event.key === 'Escape' && !ui.panel.hidden) setOpen(false);
  };
  const onUnload = () => stopStream();
  const onReturn = () => resync();

  ui.launcher.addEventListener('click', onClickLauncher);
  ui.close.addEventListener('click', onClickClose);
  ui.refresh.addEventListener('click', onClickRefresh);
  ui.list.addEventListener('click', onListClick);
  document.addEventListener('keydown', onKeydown);
  window.addEventListener('beforeunload', onUnload);
  window.addEventListener('pagehide', onUnload);
  window.addEventListener('pageshow', onReturn);
  window.addEventListener('focus', onReturn);
  checkTimer = window.setInterval(resync, STREAM_CHECK_MS);

  resync();

  const instance = {
    root,
    refresh: load,
    open: () => setOpen(true),
    close: () => setOpen(false),
    destroy() {
      if (disposed) return;
      disposed = true;
      window.clearInterval(checkTimer);
      stopStream();
      ui.launcher.removeEventListener('click', onClickLauncher);
      ui.close.removeEventListener('click', onClickClose);
      ui.refresh.removeEventListener('click', onClickRefresh);
      ui.list.removeEventListener('click', onListClick);
      document.removeEventListener('keydown', onKeydown);
      window.removeEventListener('beforeunload', onUnload);
      window.removeEventListener('pagehide', onUnload);
      window.removeEventListener('pageshow', onReturn);
      window.removeEventListener('focus', onReturn);
      root.remove();
      if (sharedInstance === instance) sharedInstance = null;
    },
  };
  sharedInstance = instance;
  return instance;
}
