/* Derived-calendar widget — shared, self-contained ES module.
   No framework, no bundler, no external dependencies. Every endpoint and
   credential comes from the getters supplied by the host app. */

const CALENDAR_HOME = 'https://atlas-calendar.surge.sh';
const CALENDAR_OVERVIEW = `${CALENDAR_HOME}/#/app/overview`;
const STYLE_ID = 'atlas-cal-widget-style';
const ROOT_ID = 'atlas-cal-widget-root';
const POLL_MS = 5000;

const CSS = `
.atlas-cal-widget, .atlas-cal-widget * { box-sizing: border-box; }
.atlas-cal-widget {
  position: fixed;
  right: 18px;
  bottom: 84px;
  z-index: 80;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 10px;
  max-width: calc(100vw - 24px);
  font-family: inherit;
  font-size: 13px;
  line-height: 1.45;
  color: currentColor;
}
.atlas-cal-widget [hidden] { display: none !important; }
.atlas-cal-widget button,
.atlas-cal-widget a { font: inherit; color: currentColor; }
.atlas-cal-widget__launcher {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 9px 14px;
  border: 1px solid rgba(128, 128, 128, .38);
  border-radius: 999px;
  background: rgba(128, 128, 128, .13);
  cursor: pointer;
  font-weight: 650;
  box-shadow: 0 8px 26px rgba(0, 0, 0, .18);
  backdrop-filter: blur(12px);
}
.atlas-cal-widget__launcher:hover { background: rgba(128, 128, 128, .22); }
.atlas-cal-widget__glyph { font-size: 15px; line-height: 1; }
.atlas-cal-widget__panel {
  width: min(360px, calc(100vw - 24px));
  max-height: min(70vh, 520px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid rgba(128, 128, 128, .38);
  border-radius: 14px;
  background: rgba(128, 128, 128, .1);
  box-shadow: 0 18px 48px rgba(0, 0, 0, .28);
  backdrop-filter: blur(18px);
}
.atlas-cal-widget__head,
.atlas-cal-widget__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 11px 14px;
}
.atlas-cal-widget__head { border-bottom: 1px solid rgba(128, 128, 128, .25); }
.atlas-cal-widget__foot { border-top: 1px solid rgba(128, 128, 128, .25); }
.atlas-cal-widget__title { margin: 0; font-size: 14px; font-weight: 700; }
.atlas-cal-widget__subtitle { margin: 2px 0 0; font-size: 11px; opacity: .7; }
.atlas-cal-widget__refresh {
  flex: none;
  padding: 5px 10px;
  border: 1px solid rgba(128, 128, 128, .35);
  border-radius: 8px;
  background: rgba(128, 128, 128, .12);
  cursor: pointer;
  font-size: 11px;
  font-weight: 650;
}
.atlas-cal-widget__refresh:hover { background: rgba(128, 128, 128, .22); }
.atlas-cal-widget__body { padding: 10px 12px; overflow-y: auto; min-height: 72px; }
.atlas-cal-widget__list { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
.atlas-cal-widget__item {
  padding: 9px 10px;
  border: 1px solid rgba(128, 128, 128, .22);
  border-radius: 10px;
  background: rgba(128, 128, 128, .07);
}
.atlas-cal-widget__meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 11px; opacity: .82; }
.atlas-cal-widget__date { font-variant-numeric: tabular-nums; font-weight: 650; }
.atlas-cal-widget__badge {
  padding: 1px 7px;
  border: 1px solid rgba(128, 128, 128, .3);
  border-radius: 999px;
  font-size: 10px;
  text-transform: capitalize;
}
.atlas-cal-widget__event-title { margin: 5px 0 0; font-size: 13px; font-weight: 650; overflow-wrap: anywhere; }
.atlas-cal-widget__desc {
  margin: 3px 0 0;
  font-size: 11px;
  opacity: .72;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.atlas-cal-widget__event-link,
.atlas-cal-widget__foot-link,
.atlas-cal-widget__note a {
  text-decoration: underline;
  text-underline-offset: 2px;
}
.atlas-cal-widget__event-link { display: inline-block; margin-top: 6px; font-size: 11px; }
.atlas-cal-widget__note { margin: 0; padding: 10px 4px; font-size: 12px; opacity: .8; }
.atlas-cal-widget__app { font-size: 10px; opacity: .6; text-transform: capitalize; }
.atlas-cal-widget__foot-link { font-size: 11px; white-space: nowrap; }
.atlas-cal-widget__launcher:focus-visible,
.atlas-cal-widget__refresh:focus-visible,
.atlas-cal-widget a:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
@media (max-width: 560px) {
  .atlas-cal-widget { right: 12px; bottom: 78px; }
  .atlas-cal-widget__panel { width: calc(100vw - 24px); max-height: 62vh; }
}
`;

function call(fn) {
  try { return typeof fn === 'function' ? fn() : ''; } catch { return ''; }
}

function str(value) { return String(value ?? '').trim(); }

function eventStart(event) {
  const row = event && typeof event === 'object' ? event : {};
  return str(row.startAt || row.start);
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function dateLabel(value) {
  const raw = str(value);
  if (!raw) return 'Date TBD';
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return raw;
  try {
    return parsed.toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  } catch { return raw; }
}

function sortEvents(events) {
  return [...events].sort((a, b) => {
    const ta = Date.parse(eventStart(a));
    const tb = Date.parse(eventStart(b));
    return (Number.isFinite(ta) ? ta : Infinity) - (Number.isFinite(tb) ? tb : Infinity);
  });
}

export function initCalendarWidget(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const appLabel = str(opts.app) || 'Atlas';
  const getEndpoint = opts.getEndpoint;
  const getToken = opts.getToken;

  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {};
  if (!document.head || !document.body || typeof document.createElement !== 'function') return () => {};

  let style = document.getElementById(STYLE_ID);
  if (!style) {
    style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    try { document.head.appendChild(style); } catch { return () => {}; }
  }
  if (document.getElementById(ROOT_ID)) return () => {};

  const root = document.createElement('div');
  root.id = ROOT_ID;
  root.className = 'atlas-cal-widget';
  root.innerHTML = `
    <section class="atlas-cal-widget__panel" id="atlas-cal-widget-panel" hidden aria-label="Derived calendar events">
      <div class="atlas-cal-widget__head">
        <div><h2 class="atlas-cal-widget__title">Derived Calendar</h2>
          <p class="atlas-cal-widget__subtitle">Dates from your other Atlas apps</p></div>
        <button type="button" class="atlas-cal-widget__refresh" data-cal-action="refresh">Refresh</button>
      </div>
      <div class="atlas-cal-widget__body" data-cal-role="body">
        <p class="atlas-cal-widget__note">Open this panel to load your dates.</p>
      </div>
      <div class="atlas-cal-widget__foot">
        <span class="atlas-cal-widget__app">${esc(appLabel)}</span>
        <a class="atlas-cal-widget__foot-link" href="${CALENDAR_OVERVIEW}" target="_blank" rel="noopener noreferrer">Open Atlas Calendar ↗</a>
      </div>
    </section>
    <button type="button" class="atlas-cal-widget__launcher" data-cal-action="toggle"
      aria-expanded="false" aria-controls="atlas-cal-widget-panel">
      <span class="atlas-cal-widget__glyph" aria-hidden="true">▦</span><span>Calendar</span>
    </button>`;

  try { document.body.appendChild(root); } catch { return () => {}; }

  const panel = root.querySelector('.atlas-cal-widget__panel');
  const launcher = root.querySelector('.atlas-cal-widget__launcher');
  const body = root.querySelector('[data-cal-role="body"]');
  const refreshButton = root.querySelector('[data-cal-action="refresh"]');
  if (!panel || !launcher || !body) {
    try { root.remove(); } catch { /* noop */ }
    return () => {};
  }

  let source = null;
  let sourceEndpoint = '';
  let sourceToken = '';
  let requestSeq = 0;
  let disposed = false;

  function config() {
    return {
      endpoint: str(call(getEndpoint)).replace(/\/+$/, ''),
      token: str(call(getToken)),
    };
  }

  function setBody(html) {
    if (!disposed) body.innerHTML = html;
  }

  function note(message) {
    return `<p class="atlas-cal-widget__note">${esc(message)}</p>`;
  }

  function renderSignIn() {
    setBody(`${note('Sign in to Atlas Sync to see dates from your other apps.')}
      <p class="atlas-cal-widget__note"><a href="${CALENDAR_HOME}" target="_blank" rel="noopener noreferrer">Open Atlas Calendar ↗</a></p>`);
  }

  function renderEvents(events) {
    if (!events.length) {
      setBody(note('No derived dates yet. Check back after your other apps sync.'));
      return;
    }
    const rows = sortEvents(events).map(event => {
      const row = event && typeof event === 'object' ? event : {};
      const title = str(row.title) || 'Untitled date';
      const from = str(row.app) || 'Atlas';
      const description = str(row.description);
      return `<li class="atlas-cal-widget__item">
        <div class="atlas-cal-widget__meta">
          <span class="atlas-cal-widget__date">${esc(dateLabel(eventStart(row)))}</span>
          <span class="atlas-cal-widget__badge">${esc(from)}</span>
        </div>
        <p class="atlas-cal-widget__event-title">${esc(title)}</p>
        ${description ? `<p class="atlas-cal-widget__desc">${esc(description)}</p>` : ''}
        <a class="atlas-cal-widget__event-link" href="${CALENDAR_OVERVIEW}" target="_blank" rel="noopener noreferrer">Open in Atlas Calendar ↗</a>
      </li>`;
    }).join('');
    setBody(`<ul class="atlas-cal-widget__list">${rows}</ul>`);
  }

  async function refresh() {
    if (disposed) return;
    const seq = ++requestSeq;
    const { endpoint, token } = config();
    ensureStream();
    if (!token) { renderSignIn(); return; }
    if (!endpoint) {
      setBody(note('No sync endpoint is configured for this app. Set one in Connector settings, then refresh.'));
      return;
    }
    if (typeof fetch !== 'function') {
      setBody(note('This browser cannot reach the calendar service. Try a modern browser.'));
      return;
    }

    setBody(note('Loading dates…'));
    try {
      const res = await fetch(`${endpoint}/api/calendar/derived`, {
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      });
      let payload = null;
      try { payload = await res.json(); } catch { payload = null; }
      if (disposed || seq !== requestSeq) return;
      if (!res.ok) {
        if (res.status === 401) { renderSignIn(); return; }
        const detail = str(payload?.error) || str(payload?.message);
        setBody(note(detail || `The calendar service returned an error (${res.status}).`));
        return;
      }
      const events = Array.isArray(payload?.events) ? payload.events
        : Array.isArray(payload) ? payload : null;
      if (!events) { setBody(note('The calendar service returned an unexpected response.')); return; }
      renderEvents(events);
    } catch {
      if (!disposed && seq === requestSeq) {
        setBody(note('Could not reach the calendar service. Check your connection and try again.'));
      }
    }
  }

  function closeStream() {
    if (source) { try { source.close(); } catch { /* noop */ } }
    source = null;
    sourceEndpoint = '';
    sourceToken = '';
  }

  function onCalendarEvent() { refresh(); }

  function ensureStream() {
    if (disposed || typeof EventSource === 'undefined') return;
    const { endpoint, token } = config();
    if (!endpoint || !token) { closeStream(); return; }
    if (source && sourceEndpoint === endpoint && sourceToken === token) return;
    closeStream();
    try {
      source = new EventSource(`${endpoint}/api/events?token=${encodeURIComponent(token)}`);
      sourceEndpoint = endpoint;
      sourceToken = token;
      source.addEventListener('calendar', onCalendarEvent);
      source.addEventListener('error', () => { /* EventSource reconnects itself */ });
    } catch {
      closeStream();
    }
  }

  function toggle() {
    if (disposed) return;
    panel.hidden = !panel.hidden;
    launcher.setAttribute('aria-expanded', String(!panel.hidden));
    if (!panel.hidden) { ensureStream(); refresh(); }
  }

  launcher.addEventListener('click', toggle);
  if (refreshButton) refreshButton.addEventListener('click', refresh);

  const poll = typeof window.setInterval === 'function'
    ? window.setInterval(() => { if (!disposed) ensureStream(); }, POLL_MS)
    : null;

  function onUnload() { closeStream(); }
  try {
    window.addEventListener('pagehide', onUnload);
    window.addEventListener('unload', onUnload);
  } catch { /* noop */ }

  return function destroyCalendarWidget() {
    if (disposed) return;
    disposed = true;
    if (poll) { try { clearInterval(poll); } catch { /* noop */ } }
    try {
      window.removeEventListener('pagehide', onUnload);
      window.removeEventListener('unload', onUnload);
    } catch { /* noop */ }
    launcher.removeEventListener('click', toggle);
    if (refreshButton) refreshButton.removeEventListener('click', refresh);
    closeStream();
    try { root.remove(); } catch { /* noop */ }
  };
}
