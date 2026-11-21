/* Atlas Calendar — controller, routing and interactions.
   Every screen renders from local state; no framework, no bundler. */
import {
  BRAND, ROUTES, APP_ROUTES, PAGE_TITLES, TYPES, TYPE_MAP, TYPE_IDS, THEMES,
  CATEGORIES, TIMEZONES, CONNECT_SOURCES, APP_LINKS,
} from './config.js';
import * as store from './store.js';
import * as api from './api.js';
import {
  mergeEvents, filterEvents, eventsInRange, typeCounts, eventTimeLabel,
  renderMonth, renderWeek, renderAgenda, renderUpcoming, renderDerivedList,
  rangeForCursor, weekRangeLabel, normalizeEvent,
} from './calendar.js';
import { densityChart, typeLegend } from './charts.js';
import {
  $, $$, esc, safeType, uid, dateInput, addDays, parseDate, dayKey, startOfDay, endOfDay,
  dateLabel, monthTitle, timeLabel, timeZoneLabel, initials, downloadText, debounce, safeHref,
} from './utils.js';

const root = $('#app');
const modalHost = $('#modal-host');
const toastHost = $('#toast-host');

const ui = {
  events: [], derived: [], merged: [], visible: [], range: { from: '', to: '' },
  cloud: 'offline', eventSub: null, eventToken: '', eventEndpoint: '',
  detailId: '', dayDate: '', eventEditId: '',
  signupType: 'personal', switchTarget: '',
  pendingDeleteId: '',
};

/* ------------------------------ helpers ------------------------------ */

function route() {
  const hash = (location.hash || '#/').replace(/\/+$/, '') || '#/';
  if (hash.startsWith('#/app/')) {
    const page = hash.split('/')[2] || 'overview';
    return { mode: 'app', page: APP_ROUTES.includes(page) ? page : 'overview' };
  }
  if (hash === '#/signin' || hash === '#/login') return { mode: 'auth', kind: 'signin' };
  if (hash === '#/signup') return { mode: 'auth', kind: 'signup' };
  return { mode: 'landing' };
}

function go(hash) {
  if (location.hash === hash) routeEntered();
  else location.hash = hash;
}

function requiredMode() {
  try {
    const mode = new URLSearchParams(location.search).get('mode');
    return mode === 'business' || mode === 'developer' ? mode : '';
  } catch { return ''; }
}

function clearModeParam() {
  const url = new URL(location.href);
  if (!url.searchParams.has('mode')) return;
  url.searchParams.delete('mode');
  history.replaceState(null, '', url.pathname + url.search + url.hash);
}

function applyTheme() {
  const theme = store.getSetting('theme') === 'paper' ? 'paper' : 'ink';
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'ink' ? '#071522' : '#f5f3ed');
}

function tz() { return store.getSetting('timeZone') || 'auto'; }
function endpointLabel() { return api.urlOverride() ? `${api.endpoint()} (URL override)` : api.endpoint(); }

function toast(message, type = 'success') {
  if (!toastHost) return;
  const el = document.createElement('div');
  el.className = `toast ${type === 'error' ? 'error' : ''}`;
  el.innerHTML = `<span class="ic">${type === 'error' ? '⚠' : '✓'}</span><span>${esc(message)}</span>`;
  toastHost.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateY(8px)'; }, 3600);
  setTimeout(() => el.remove(), 4000);
}

function openModal(html, wide = false) {
  if (!modalHost) return;
  modalHost.innerHTML = `<div class="overlay" data-action="modal-backdrop"><div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">${html}</div></div>`;
  document.body.style.overflow = 'hidden';
  const first = modalHost.querySelector('input:not([type="hidden"]), select, textarea, button');
  if (first) setTimeout(() => { try { first.focus(); } catch { /* noop */ } }, 40);
}
function closeModal() {
  if (modalHost) modalHost.innerHTML = '';
  document.body.style.overflow = '';
  ui.eventEditId = '';
  ui.pendingDeleteId = '';
}
function modalHead(title, sub = '') {
  return `<div class="modal-head"><div><h2>${esc(title)}</h2>${sub ? `<p>${esc(sub)}</p>` : ''}</div>
    <button type="button" class="btn btn-icon btn-ghost" data-action="modal-close" aria-label="Close">✕</button></div>`;
}
function formError(form, message) {
  const el = form?.querySelector('.form-error');
  if (el) el.textContent = String(message || '');
}
function val(formData, key) { return String(formData.get(key) ?? '').trim(); }

function brandMark() {
  return `<span class="brand-mark" aria-hidden="true"><svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="16" cy="16" r="10.2"/><path d="M16 9.2v7.1l5 3.1"/><circle cx="16" cy="16" r="1.6" fill="currentColor" stroke="none"/>
  </svg></span>`;
}
function brand(label = BRAND.dba, sub = 'A product of Atlas Financial') {
  return `<span class="brand">${brandMark()}<span>${esc(label)}<span class="brand-sub">${esc(sub)}</span></span></span>`;
}
function emptyState(icon, title, message, button = '') {
  return `<div class="empty"><div class="big">${icon}</div><h3>${esc(title)}</h3><p>${esc(message)}</p>${button}</div>`;
}
function nextHour() {
  const d = new Date();
  d.setHours(Math.min(d.getHours() + 1, 23), 0, 0, 0);
  return `${String(d.getHours()).padStart(2, '0')}:00`;
}
function visibleTypes() {
  return TYPES.filter(t => !(store.getSetting('hiddenTypes') || []).includes(t.id));
}

/* ------------------------------ data ------------------------------ */

function recomputeVisible() {
  const settings = store.state().settings;
  const from = parseDate(ui.range.from || dateInput());
  const to = parseDate(ui.range.to || dateInput());
  const inRange = from && to ? eventsInRange(ui.merged, startOfDay(from), endOfDay(to)) : ui.merged;
  ui.visible = filterEvents(inRange, { filterType: settings.filterType, hiddenTypes: settings.hiddenTypes });
}

async function refreshEvents({ silent = false } = {}) {
  const st = store.state();
  const range = rangeForCursor(st.settings.cursor);
  ui.range = range;
  let manualOk = false;
  let derivedOk = false;
  if (st.token) {
    const [manual, derived] = await Promise.all([
      api.getEvents({ from: range.from, to: range.to }),
      api.getDerived(),
    ]);
    if (manual.ok) { store.cacheEvents(manual.data?.events || []); manualOk = true; }
    if (derived.ok) { store.cacheDerived(derived.data?.events || []); derivedOk = true; }
    if (!manual.ok || !derived.ok) store.setSyncMeta({ lastError: manual.error || derived.error || 'Sync unavailable' });
  }
  const fresh = store.state();
  ui.events = fresh.events;
  ui.derived = fresh.derived;
  ui.merged = mergeEvents(ui.events, ui.derived);
  recomputeVisible();
  if (!silent) render();
}

const liveRefresh = debounce(() => {
  refreshEvents({ silent: true }).then(() => render());
}, 700);

function stopLive() {
  try { ui.eventSub?.close(); } catch { /* noop */ }
  ui.eventSub = null;
}

function startLive(force = false) {
  const st = store.state();
  if (!st.token) { stopLive(); ui.cloud = 'offline'; return; }
  if (!force && ui.eventSub && ui.eventToken === st.token && ui.eventEndpoint === api.endpoint()) return;
  stopLive();
  ui.eventToken = st.token;
  ui.eventEndpoint = api.endpoint();
  ui.eventSub = api.subscribeEvents({
    token: st.token,
    onStatus(status) { ui.cloud = status; updateCloudBadge(); },
    onEvent() { liveRefresh(); },
  });
}

function updateCloudBadge() {
  const el = $('#cloud-status');
  if (!el) return;
  const live = ui.cloud === 'live';
  el.className = `status-line ${live ? 'live' : 'offline'}`;
  el.innerHTML = `<i></i><span>${live ? 'Live updates connected' : (store.state().token ? 'Live updates offline' : 'Local-only mode')}</span>`;
}

function applyAuth(payload) {
  store.setAuthResult(payload, api.endpoint());
}

/* ------------------------------ landing ------------------------------ */

function landingView() {
  const authed = !!store.state().token;
  const typeCards = TYPES.map(t => `
    <article class="type-card type-${t.id}">
      <div class="type-icon">${esc(t.label[0])}</div>
      <h3>${esc(t.label)}</h3>
      <p>${esc(t.description)}</p>
      <div class="type-line"></div>
    </article>`).join('');
  const connects = CONNECT_SOURCES.map(s => `
    <article class="connect-card">
      <div class="connect-tag">Derived events</div>
      <h3>${esc(s.name)}</h3>
      <p>${esc(s.note)}. Read-only, always linked back to the source.</p>
    </article>`).join('');
  return `<div class="landing">
    <div class="nav-wrap"><nav class="nav" aria-label="Main navigation">
      <a href="${ROUTES.landing}">${brand()}</a>
      <div class="nav-links"><a href="#" data-action="scroll-connect">See how it connects</a><a href="#/app/overview">My calendar</a></div>
      <div class="nav-actions">
        <a class="btn btn-ghost btn-sm" href="${ROUTES.signin}">Sign in</a>
        <a class="btn btn-primary btn-sm" href="${authed ? ROUTES.overview : ROUTES.signup}">${authed ? 'Open calendar' : 'Get started'}</a>
      </div>
    </nav></div>

    <header class="hero">
      <div>
        <span class="eyebrow"><span class="pulse"></span>A product of Atlas Financial</span>
        <h1>Everything<br/><em>in time.</em></h1>
        <p class="hero-copy">One calm calendar for the whole of your life. Keep your own plans, your family's schedule, your business deadlines and your shipping windows together — with one account across every Atlas app.</p>
        <div class="hero-ctas">
          <a class="btn btn-primary btn-lg" href="${authed ? ROUTES.overview : ROUTES.signup}">Open my calendar →</a>
          <button type="button" class="btn btn-lg" data-action="scroll-connect">See how it connects</button>
        </div>
        <div class="hero-note"><span>✓ Manual events</span><span>✓ Derived from your Atlas apps</span><span>✓ No external sign-in</span></div>
      </div>
      <div class="hero-visual" aria-hidden="true">
        <div class="hero-glow"></div>
        <div class="mock-card">
          <div class="mock-top"><span>ATLAS CALENDAR · MONTH</span><span>${esc(monthTitle(new Date()))}</span></div>
          <div class="mock-title">A quieter way to see it all.</div>
          <div class="mock-grid">
            ${['M', 'T', 'W', 'T', 'F', 'S', 'S'].map(d => `<div class="mock-day" style="min-height:20px;text-align:center;color:var(--muted)">${d}</div>`).join('')}
            ${Array.from({ length: 28 }, (_, i) => `<div class="mock-day ${i === 9 ? 'today' : ''}">${i + 1}<span class="mock-pill ${i % 4 === 1 ? 'coral' : i % 4 === 2 ? 'violet' : i % 4 === 3 ? 'cyan' : ''}"></span>${i % 5 === 0 ? '<span class="mock-pill violet"></span>' : ''}</div>`).join('')}
          </div>
        </div>
        <div class="float-chip one"><span class="dot"></span>Family · School pickup</div>
        <div class="float-chip two"><span class="dot cyan"></span>Developer · Release 2.4</div>
      </div>
    </header>

    <section class="section" aria-labelledby="types-title">
      <div class="section-head"><span class="eyebrow">Four clear colors</span>
        <h2 id="types-title">One account. Four ways to be busy.</h2>
        <p>Switch between personal, family, business and developer profiles without losing the thread. Every event keeps its own color and its own home.</p>
      </div>
      <div class="type-grid">${typeCards}</div>
    </section>

    <section class="flow-band" id="connects">
      <div class="flow-inner">
        <div class="section-head" style="margin-bottom:0"><span class="eyebrow">See how it connects</span>
          <h2>Your other apps already know what's coming.</h2>
          <p>Atlas Calendar reads event snapshots from the rest of the family. Deadlines appear here as read-only entries that link straight back to their source app.</p>
        </div>
        <div class="flow-steps">
          <div class="flow-step"><b>1</b><div><strong>Each app keeps its own data</strong><span>No provider APIs, no OAuth, no duplicated sources of truth.</span></div></div>
          <div class="flow-step"><b>2</b><div><strong>Atlas Sync carries the dates</strong><span>Snapshots and calendar frames arrive over one authenticated channel.</span></div></div>
          <div class="flow-step"><b>3</b><div><strong>Your calendar shows the whole picture</strong><span>Manual events stay editable; derived events stay linked and read-only.</span></div></div>
        </div>
      </div>
    </section>

    <section class="section" aria-labelledby="connect-title">
      <div class="section-head"><span class="eyebrow">Connected by design</span><h2 id="connect-title">Derived from the Atlas family</h2>
        <p>These apps contribute dates automatically when they are connected to the same account. Nothing is written into them from here.</p>
      </div>
      <div class="connect-grid">${connects}</div>
    </section>

    <section class="cta-band">
      <h2>Make room for everything.</h2>
      <p>Start with a personal calendar. Add the other profiles whenever you need them.</p>
      <a class="btn btn-primary btn-lg" href="${authed ? ROUTES.overview : ROUTES.signup}">Open my calendar</a>
    </section>
    <footer class="footer">${esc(BRAND.tagline)} · ${esc(BRAND.legal)} · © ${BRAND.year}</footer>
  </div>`;
}

/* ------------------------------- auth ------------------------------- */

function typeOption(t, checked) {
  return `<label class="type-option type-${t.id} ${checked ? 'selected' : ''}">
    <input type="radio" name="type" value="${t.id}" ${checked ? 'checked' : ''}/>
    <strong><i></i>${esc(t.label)}</strong><small>${esc(t.description)}</small>
  </label>`;
}

function authView(kind) {
  const signup = kind === 'signup';
  const active = store.activeType();
  return `<div class="auth-wrap">
    <aside class="auth-aside">
      <a href="${ROUTES.landing}">${brand()}</a>
      <div><h2>One account.<br/><em>Everything in time.</em></h2>
        <p>Your personal plans, family schedule, business deadlines and developer releases — separate where it matters, together where it counts.</p>
        <div class="auth-points">${TYPES.map(t => `<div class="type-${t.id}"><i style="background:var(--type)"></i>${esc(t.label)} calendar</div>`).join('')}</div>
      </div>
      <p class="faint small">A product of ${esc(BRAND.legal)}. No Google or OAuth sign-in.</p>
    </aside>
    <div class="auth-card-wrap"><div class="auth-card">
      ${brand('Atlas Calendar', '')}
      <h1>${signup ? 'Create your calendar' : 'Welcome back'}</h1>
      <p>${signup ? 'Choose the profile you want to start with. You can add more later.' : 'Sign in with your Atlas account to continue.'}</p>
      <div class="auth-tabs">
        <a href="${ROUTES.signin}" class="${signup ? '' : 'active'}">Sign in</a>
        <a href="${ROUTES.signup}" class="${signup ? 'active' : ''}">Sign up</a>
      </div>
      <form data-form="${signup ? 'signup' : 'signin'}" novalidate>
        ${signup ? `<div class="field"><label>Account type</label>
          <div class="type-select">${TYPES.map(t => typeOption(t, ui.signupType === t.id)).join('')}</div></div>` : ''}
        <div class="field"><label for="auth-email">Email</label>
          <input class="input" id="auth-email" name="email" type="email" autocomplete="email" placeholder="you@example.com" value="${esc(store.state().email || '')}"/></div>
        <div class="field"><label for="auth-password">Password</label>
          <input class="input" id="auth-password" name="password" type="password" autocomplete="${signup ? 'new-password' : 'current-password'}" placeholder="At least 8 characters"/></div>
        ${signup ? `<div class="field"><label for="auth-name">Your name <span class="faint">(optional)</span></label>
          <input class="input" id="auth-name" name="name" type="text" autocomplete="name" placeholder="Your name"/></div>`
          : `<div class="field"><label for="auth-type">Opening as <span class="faint">(optional)</span></label>
          <select class="input" id="auth-type" name="type"><option value="">Default profile</option>
            ${TYPES.map(t => `<option value="${t.id}" ${active === t.id ? 'selected' : ''}>${esc(t.label)}</option>`).join('')}</select></div>`}
        <div class="form-error" role="alert"></div>
        <button class="btn btn-primary btn-lg" type="submit" style="width:100%">${signup ? 'Create account' : 'Sign in'}</button>
      </form>
      <p class="auth-foot">If the Atlas Sync endpoint is unavailable, Atlas Calendar continues in local-only mode using this browser. Your password is never stored locally.</p>
      <p class="auth-foot"><a href="${ROUTES.landing}">← Back to Atlas Calendar</a></p>
    </div></div>
  </div>`;
}

/* ------------------------------- 403 ------------------------------- */

function forbiddenView(required) {
  const info = TYPE_MAP[required];
  return `<div class="forbidden"><div class="forbidden-card type-${required}">
    <div class="lock">⌁</div>
    <div class="forbidden-code">403</div>
    <h1>${esc(info.label)} access required</h1>
    <p>${esc(BRAND.dba)} keeps personal and family profiles separate from workspaces that need a ${esc(info.label.toLowerCase())} profile. Your current profile can't open this workspace, but your other calendars stay exactly where they are.</p>
    <div class="forbidden-actions">
      <button type="button" class="btn btn-primary" data-action="create-required-profile" data-type="${esc(required)}">Create ${esc(info.label)} profile now</button>
      <button type="button" class="btn" data-action="back-calendar">Back to my calendar</button>
    </div>
    <p class="faint tiny" style="margin-top:22px">You can also <button type="button" class="btn btn-ghost btn-sm" style="color:var(--gold)" data-action="goto-required-signup" data-type="${esc(required)}">sign up with a ${esc(info.label.toLowerCase())} profile</button>.</p>
  </div></div>`;
}

/* ----------------------------- app shell ----------------------------- */

function sideNav(page) {
  const items = [
    { page: 'overview', icon: '◇', label: 'Overview' },
    { page: 'month', icon: '▦', label: 'Month' },
    { page: 'week', icon: '▤', label: 'Week' },
    { page: 'agenda', icon: '☰', label: 'Agenda' },
    { page: 'settings', icon: '⚙', label: 'Settings' },
  ];
  return items.map(item => `<a class="side-link ${item.page === page ? 'active' : ''}" href="${ROUTES[item.page]}" aria-current="${item.page === page ? 'page' : 'false'}">
    <span class="ic">${item.icon}</span>${item.label}</a>`).join('');
}

function sidebarView(page, counts) {
  const st = store.state();
  const active = safeType(st.profile?.type);
  const profiles = st.profiles.length ? st.profiles.map(p => {
    const type = safeType(p.type);
    return `<button type="button" class="profile-row type-${type} ${type === active ? 'active' : ''}" data-action="switch-profile" data-type="${esc(type)}">
      <span class="dot"></span><span><span class="profile-name">${esc(p.name || TYPE_MAP[type].label)}</span><br/><span class="profile-type">${esc(TYPE_MAP[type].label)} profile</span></span></button>`;
  }).join('') : '<p class="faint small">No profiles yet.</p>';
  const filters = [{ id: 'all', label: 'All' }, ...TYPES].map(f => `
    <button type="button" class="type-filter ${f.id === 'all' ? '' : `type-${f.id}`} ${st.settings.filterType === f.id ? 'active' : ''} ${(st.settings.hiddenTypes || []).includes(f.id) ? 'hidden-type' : ''}"
      data-action="switch-filter" data-type="${esc(f.id)}">
      <span class="dot" ${f.id === 'all' ? 'style="background:var(--gold)"' : ''}></span>${esc(f.label)}<span class="filter-count">${counts[f.id] || 0}</span>
    </button>`).join('');
  return `<aside class="sidebar" id="sidebar" aria-label="Calendar sidebar">
    <div class="side-brand"><a href="${ROUTES.landing}">${brand()}</a></div>
    <div class="side-section">
      <div class="side-label">Your profiles</div>
      <div class="profile-panel">
        <div class="profile-panel-top type-${active}">
          <span class="profile-avatar">${esc(initials(st.profile?.name || TYPE_MAP[active].label))}</span>
          <span><span class="profile-name">${esc(st.profile?.name || TYPE_MAP[active].label)}</span><br/>
            <span class="profile-type">${esc(TYPE_MAP[active].label)} · ${st.token ? 'Synced' : 'Local'}</span></span>
        </div>
        <div class="profile-list">${profiles}</div>
        <button type="button" class="btn btn-sm" style="width:100%;margin-top:10px" data-action="open-profile-create">+ Add a profile</button>
      </div>
    </div>
    <div class="side-section"><div class="side-label">Calendar</div><nav class="side-nav">${sideNav(page)}</nav></div>
    <div class="side-section"><div class="side-label">Filter by type</div><div class="side-nav">${filters}</div></div>
    <div class="side-section"><div class="side-label">Workspaces</div>
      <a class="side-cta" href="#" data-action="workspace" data-type="business">◈ Open business workspace ↗</a>
      <a class="side-cta" href="#" data-action="workspace" data-type="developer">◈ Open developer workspace ↗</a>
    </div>
    <div class="side-foot">
      <div class="status-line ${ui.cloud === 'live' ? 'live' : 'offline'}" id="cloud-status"><i></i><span>${ui.cloud === 'live' ? 'Live updates connected' : (st.token ? 'Live updates offline' : 'Local-only mode')}</span></div>
      <div>Endpoint: <code>${esc(api.endpoint())}</code></div>
      <div style="margin-top:10px"><button type="button" class="btn btn-ghost btn-sm" data-action="signout">Sign out</button></div>
      <div style="margin-top:8px">${esc(BRAND.tagline)} · ${esc(BRAND.legal)}</div>
    </div>
  </aside>`;
}

function topbarView(page) {
  const st = store.state();
  const cursor = parseDate(st.settings.cursor) || new Date();
  const active = safeType(st.profile?.type);
  const sub = page === 'week' ? weekRangeLabel(cursor) : monthTitle(cursor);
  const switcher = ['month', 'week', 'agenda'].map(v => `<a class="${v === page ? 'active' : ''}" href="${ROUTES[v]}">${PAGE_TITLES[v]}</a>`).join('');
  return `<header class="topbar">
    <div class="topbar-left">
      <button type="button" class="btn btn-icon menu-btn" data-action="sidebar-toggle" aria-label="Open menu">☰</button>
      <div><div class="topbar-title">${esc(PAGE_TITLES[page])}</div><div class="topbar-sub">${esc(sub)}</div></div>
      <div class="view-switch" role="tablist" aria-label="Calendar view">${switcher}</div>
    </div>
    <div class="nav-arrows">
      <button type="button" class="btn btn-icon" data-action="prev-period" aria-label="Previous period">‹</button>
      <button type="button" class="btn btn-sm" data-action="today-period">Today</button>
      <button type="button" class="btn btn-icon" data-action="next-period" aria-label="Next period">›</button>
    </div>
    <div class="topbar-right">
      <button type="button" class="btn btn-primary btn-sm" data-action="new-event">+ New event</button>
      <button type="button" class="btn btn-icon" data-action="toggle-theme" aria-label="Toggle theme">${st.settings.theme === 'paper' ? '☾' : '☀'}</button>
      <button type="button" class="profile-chip type-${active}" data-action="open-switcher" aria-label="Switch profile">
        <span class="avatar">${esc(initials(st.profile?.name || TYPE_MAP[active].label))}</span>${esc(TYPE_MAP[active].label)}
      </button>
    </div>
  </header>`;
}

function banners() {
  const st = store.state();
  const out = [];
  if (!st.settings.onboardingComplete) {
    out.push(`<div class="banner"><span class="pulse"></span><span><strong>Welcome to Atlas Calendar.</strong> Add a manual event, or wait for dates to arrive from your other Atlas apps.</span>
      <button type="button" class="btn btn-sm" data-action="dismiss-onboarding">Got it</button></div>`);
  }
  if (api.urlOverride()) {
    out.push(`<div class="banner"><span>⌁</span><span>Using endpoint override <code>${esc(api.endpoint())}</code></span><a class="btn btn-sm" href="${ROUTES.settings}">Settings</a></div>`);
  }
  if (!st.token) {
    out.push(`<div class="banner banner-warn"><span>⚠</span><span><strong>Local-only mode.</strong> Sign in when Atlas Sync is available to sync across devices.</span><a class="btn btn-sm" href="${ROUTES.signin}">Sign in</a></div>`);
  } else if (ui.cloud !== 'live') {
    out.push(`<div class="banner banner-warn"><span>⚠</span><span><strong>Live updates offline.</strong> Your changes are saved in this browser and will sync when the endpoint returns.</span></div>`);
  }
  return out.join('');
}

function overviewView() {
  const derived = ui.merged.filter(e => e.derived);
  const counts = typeCounts(ui.merged);
  const now = startOfDay(new Date());
  const next7 = eventsInRange(ui.merged, now, endOfDay(addDays(now, 6)));
  const stats = `
    <div class="stat-grid">
      <div class="stat-card"><div class="stat-label">Next 7 days</div><div class="stat-value">${next7.length}</div><div class="stat-note">across every profile</div></div>
      <div class="stat-card type-personal"><div class="stat-label">Personal</div><div class="stat-value" style="color:var(--type)">${counts.personal}</div><div class="stat-note">your own plans</div></div>
      <div class="stat-card type-family"><div class="stat-label">Family</div><div class="stat-value" style="color:var(--type)">${counts.family}</div><div class="stat-note">shared time</div></div>
      <div class="stat-card type-developer"><div class="stat-label">Derived</div><div class="stat-value" style="color:var(--type)">${derived.length}</div><div class="stat-note">from other Atlas apps</div></div>
    </div>`;
  return `<div class="page-head"><div><h1>Overview</h1><p>${esc(monthTitle(store.state().settings.cursor))} · a quiet look at what is coming.</p></div>
      <button type="button" class="btn btn-primary" data-action="new-event">+ New event</button></div>
    ${stats}
    <div class="overview-grid">
      <section class="panel"><div class="panel-head"><div><h2>Next 7 days</h2><p>Manual and derived events together</p></div><a class="btn btn-sm" href="${ROUTES.agenda}">Full agenda</a></div>
        <div class="panel-body flush">${renderUpcoming(ui.merged, { days: 7, timeZone: tz() }) || emptyState('◇', 'Nothing scheduled', 'Your next seven days are wide open. Add an event or connect another Atlas app.')}</div>
      </section>
      <section class="panel"><div class="panel-head"><div><h2>From your other apps</h2><p>Read-only, linked to the source</p></div><button type="button" class="btn btn-sm" data-action="refresh-derived">Refresh</button></div>
        <div class="panel-body flush">${renderDerivedList(derived, { limit: 6, timeZone: tz() }) || emptyState('↗', 'No derived events yet', 'Dates from Meridian, Airo, Tandem, Atlas Business and Atlas Developers will appear here.')}</div>
      </section>
    </div>
    <section class="panel" style="margin-top:18px"><div class="panel-head"><div><h2>Event density</h2><p>Your next 14 days, colored by profile type</p></div></div>
      <div class="panel-body">${densityChart(ui.merged, { days: 14, from: dateInput(now), height: 150 })}${typeLegend(counts)}</div>
    </section>`;
}

function monthView() {
  return `<div class="page-head"><div><h1>Month</h1><p>Click a day for details, or the + to add an event.</p></div>
      <button type="button" class="btn btn-primary" data-action="new-event">+ New event</button></div>
    ${renderMonth({ cursor: parseDate(store.state().settings.cursor), events: ui.visible, timeZone: tz() })}`;
}

function weekView() {
  return `<div class="page-head"><div><h1>Week</h1><p>Timed events sit on the hour grid; all-day events stay at the top.</p></div>
      <button type="button" class="btn btn-primary" data-action="new-event">+ New event</button></div>
    <div class="week-host">${renderWeek({ cursor: parseDate(store.state().settings.cursor), events: ui.visible, timeZone: tz() })}</div>`;
}

function agendaView() {
  return `<div class="page-head"><div><h1>Agenda</h1><p>Everything in the current range, grouped by date.</p></div>
      <button type="button" class="btn btn-primary" data-action="new-event">+ New event</button></div>
    ${renderAgenda({ events: ui.visible, timeZone: tz() }) || emptyState('☰', 'No events in this range', 'Move to another month, change your filters, or add a new event.', '<button class="btn btn-primary" data-action="new-event">+ New event</button>')}`;
}

function settingsView() {
  const st = store.state();
  const s = st.settings;
  const typeToggles = TYPES.map(t => `<label class="toggle-type type-${t.id}"><i></i>
    <span>${esc(t.label)}</span><input type="checkbox" data-action="toggle-hidden" data-type="${esc(t.id)}" ${(s.hiddenTypes || []).includes(t.id) ? 'checked' : ''} aria-label="Hide ${esc(t.label)} events"/></label>`).join('');
  return `<div class="page-head"><div><h1>Settings</h1><p>Preferences for this browser, with an optional snapshot to Atlas Sync.</p></div></div>
    <div class="settings-grid">
      <section class="setting-block"><h2>Appearance</h2><p>How your calendar looks and reads.</p>
        <div class="setting-row"><div><div class="label">Theme</div><div class="hint">Ink is the default; Paper is gentler in daylight.</div></div>
          <select class="input" data-action="setting-theme">${THEMES.map(t => `<option value="${t}" ${t === s.theme ? 'selected' : ''}>${t === 'ink' ? 'Ink' : 'Paper'}</option>`).join('')}</select></div>
        <div class="setting-row"><div><div class="label">Time zone display</div><div class="hint">Currently: ${esc(timeZoneLabel(s.timeZone))}</div></div>
          <select class="input" data-action="setting-timezone">${TIMEZONES.map(zone => `<option value="${esc(zone)}" ${zone === s.timeZone ? 'selected' : ''}>${esc(zone === 'auto' ? 'Device default' : zone)}</option>`).join('')}</select></div>
        <div class="setting-row" style="display:block"><div class="label" style="margin-bottom:10px">Hidden types</div><div class="toggle-types">${typeToggles}</div></div>
        <div class="setting-row"><div><div class="label">Onboarding</div><div class="hint">Show the welcome banner again.</div></div>
          <button type="button" class="btn btn-sm" data-action="reset-onboarding">Show tips</button></div>
      </section>

      <section class="setting-block"><h2>Sync endpoint</h2><p>Default: <code>https://atlas-sync.greenhenry441.workers.dev</code>. Change this only if you run your own Atlas Sync backend.</p>
        <div class="setting-row" style="display:block">
          <div class="label" style="margin-bottom:8px">Atlas Sync API endpoint</div>
          <input class="input" id="endpoint-input" type="url" value="${esc(api.endpoint())}" placeholder="https://atlas-sync.greenhenry441.workers.dev"/>
          <div class="hint" style="margin-top:8px">A <code>?endpoint=</code> URL parameter takes precedence while it is present.</div>
        </div>
        <div class="setting-row"><button type="button" class="btn btn-primary btn-sm" data-action="save-endpoint">Save endpoint</button>
          <button type="button" class="btn btn-sm" data-action="refresh-derived">Refresh derived events</button></div>
        <div class="setting-row"><div><div class="label">Snapshot preferences</div><div class="hint">Stores settings under client <code>${esc(store.getClientId())}</code>.</div></div>
          <button type="button" class="btn btn-sm" data-action="snapshot-settings">Snapshot now</button></div>
        <div class="setting-row"><div><div class="label">Connection</div><div class="hint">${esc(endpointLabel())}</div></div>
          <span class="badge ${ui.cloud === 'live' ? 'up' : 'neutral'}">${esc(ui.cloud === 'live' ? 'Live' : 'Offline')}</span></div>
      </section>

      <section class="setting-block"><h2>Profiles & access</h2><p>One account, several calendars. Switching a cloud profile may ask for your password once.</p>
        ${TYPES.map(t => {
          const has = st.profiles.some(p => safeType(p.type) === t.id);
          return `<div class="setting-row type-${t.id}"><div><div class="label"><span style="color:var(--type)">●</span> ${esc(t.label)}</div>
            <div class="hint">${has ? 'Profile available' : 'Not created yet'}</div></div>
            ${has ? `<button type="button" class="btn btn-sm" data-action="switch-profile" data-type="${t.id}">Switch</button>`
              : `<button type="button" class="btn btn-sm" data-action="create-profile" data-type="${t.id}">Create</button>`}</div>`;
        }).join('')}
        <div class="setting-row"><div><div class="label">Business / developer workspaces</div><div class="hint">Requires the matching profile type.</div></div>
          <div class="btn-row"><a class="btn btn-sm" href="#" data-action="workspace" data-type="business">Business</a>
          <a class="btn btn-sm" href="#" data-action="workspace" data-type="developer">Developer</a></div></div>
      </section>

      <section class="setting-block danger-zone"><h2>Local data</h2><p>Export or import preferences and locally saved events as JSON.</p>
        <div class="setting-row"><div><div class="label">Export preferences</div><div class="hint">Includes settings and locally created events — never a password or token.</div></div>
          <button type="button" class="btn btn-sm" data-action="export-prefs">Export JSON</button></div>
        <div class="setting-row"><div><div class="label">Import preferences</div><div class="hint">Replaces local preferences and locally saved events.</div></div>
          <input id="import-file" type="file" accept="application/json,.json" class="input" style="max-width:200px"/></div>
        <div class="setting-row"><div><div class="label">Clear local data</div><div class="hint">Removes local events, the derived cache and all preferences.</div></div>
          <button type="button" class="btn btn-danger btn-sm" data-action="clear-data">Clear</button></div>
      </section>
    </div>`;
}

function drawerFor(type, data) {
  if (type === 'day') {
    const date = parseDate(data);
    const rows = (ui.visible || []).filter(e => dayKey(new Date(e.start || e.date)) === dayKey(date));
    return `<div class="drawer-backdrop" data-action="close-drawer"></div><aside class="drawer" role="dialog" aria-label="Day details">
      <div class="drawer-head"><div><div class="side-label">Day</div><h2>${esc(dateLabel(date, { weekday: true, year: true }))}</h2></div>
        <button type="button" class="btn btn-icon btn-ghost" data-action="close-drawer" aria-label="Close">✕</button></div>
      <div class="detail-list">${rows.length ? rows.map(e => `
        <button type="button" class="detail-row ${e.derived ? 'is-derived' : ''} type-${e.type}" data-action="event-detail" data-id="${esc(e.id)}" style="text-align:left">
          <span class="k">${esc(eventTimeLabel(e, tz()))}</span><span><strong>${esc(e.title)}</strong><br/><small class="muted">${esc(e.derived ? `from ${e.appLabel}` : e.category || 'Manual')}</small></span>
        </button>`).join('') : '<div class="empty"><p>No events on this day.</p></div>'}</div>
      <button type="button" class="btn btn-primary" style="width:100%;margin-top:18px" data-action="new-event" data-date="${esc(dayKey(date))}">+ Add event on this day</button>
    </aside>`;
  }
  const event = ui.merged.find(e => e.id === data);
  if (!event) return '';
  const manual = !event.derived;
  const target = event.href;
  return `<div class="drawer-backdrop" data-action="close-drawer"></div><aside class="drawer" role="dialog" aria-label="Event details">
    <div class="drawer-head"><div><div class="side-label type-${event.type}">${esc(TYPE_MAP[event.type].label)} profile</div><h2>${esc(event.title)}</h2></div>
      <button type="button" class="btn btn-icon btn-ghost" data-action="close-drawer" aria-label="Close">✕</button></div>
    <div class="detail-list type-${event.type}">
      <div class="detail-row"><span class="k">When</span><span>${esc(dateLabel(event.start, { weekday: true, year: true }))}<br/><span class="muted">${esc(eventTimeLabel(event, tz()))}${event.allDay ? ' · all day' : ''}</span></span></div>
      <div class="detail-row"><span class="k">Type</span><span><span class="type-badge">${esc(TYPE_MAP[event.type].label)}</span></span></div>
      <div class="detail-row"><span class="k">Category</span><span>${esc(event.category || 'General')}</span></div>
      ${event.location ? `<div class="detail-row"><span class="k">Location</span><span>${esc(event.location)}</span></div>` : ''}
      <div class="detail-row"><span class="k">Source</span><span>${manual ? 'Manual event · editable' : `Derived from ${esc(event.appLabel)} · read-only`}</span></div>
      ${event.description ? `<div class="detail-note">${esc(event.description)}</div>` : ''}
    </div>
    <div class="btn-row" style="margin-top:20px">
      ${manual ? `<button type="button" class="btn btn-primary" data-action="edit-event" data-id="${esc(event.id)}">Edit event</button>
        <button type="button" class="btn btn-danger" data-action="delete-confirm" data-id="${esc(event.id)}">Delete</button>`
        : (target ? `<a class="btn btn-primary" href="${esc(safeHref(target))}" target="_blank" rel="noopener noreferrer">Open in ${esc(event.appLabel)} ↗</a>` : '<span class="muted small">Open its source app to make changes.</span>')}
    </div>
  </aside>`;
}

function render() {
  applyTheme();
  recomputeVisible();
  if (!root) return;
  const r = route();
  const gated = requiredMode() && safeType(store.state().profile?.type) !== requiredMode();
  if (gated) { root.innerHTML = forbiddenView(requiredMode()); return; }
  if (r.mode === 'landing') { root.innerHTML = landingView(); return; }
  if (r.mode === 'auth') { root.innerHTML = authView(r.kind); return; }
  const page = r.page;
  const counts = typeCounts(ui.merged);
  const content = page === 'overview' ? overviewView()
    : page === 'month' ? monthView()
      : page === 'week' ? weekView()
        : page === 'agenda' ? agendaView()
          : settingsView();
  const drawer = ui.dayDate ? drawerFor('day', ui.dayDate)
    : ui.detailId ? drawerFor('detail', ui.detailId) : '';
  root.innerHTML = `<div class="app-shell">
    <div class="mobile-scrim" data-action="close-sidebar"></div>
    ${sidebarView(page, counts)}
    <div class="main">${topbarView(page)}<div class="app-content">${banners()}${content}</div></div>
    ${drawer}
  </div>`;
  updateCloudBadge();
}

/* ----------------------------- route flow ----------------------------- */

function routeEntered() {
  applyTheme();
  const r = route();
  render();
  if (r.mode === 'app') {
    refreshEvents();
    startLive();
  } else {
    stopLive();
  }
}

/* ------------------------------ modals ------------------------------ */

function eventModal(id, date) {
  const editing = id ? ui.merged.find(e => e.id === id) : null;
  if (editing && editing.derived) { toast('Derived events are read-only. Open the source app instead.', 'error'); return; }
  const raw = editing?.raw || {};
  const startValue = editing ? String(raw.start || '').slice(0, 10) : (date || dateInput());
  const endValue = editing ? String(raw.end || '').slice(0, 10) || startValue : startValue;
  const startTime = editing && !editing.allDay ? String(raw.start || '').slice(11, 16) || '09:00' : nextHour();
  const endTime = editing && !editing.allDay ? String(raw.end || '').slice(11, 16) || '10:00' : (() => {
    const [h, m] = startTime.split(':').map(Number);
    const d = new Date(2020, 0, 1, h + 1, m || 0);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  })();
  ui.eventEditId = editing?.id || '';
  const type = editing ? editing.type : store.activeType();
  const source = editing ? (editing.app === 'calendar' ? 'calendar' : editing.app) : 'calendar';
  openModal(`${modalHead(editing ? 'Edit event' : 'New event', editing ? 'Changes are saved to this calendar.' : 'Add a manual event to Atlas Calendar.')}
    <form data-form="event" novalidate>
      <div class="field"><label for="ev-title">Title</label><input class="input" id="ev-title" name="title" value="${esc(raw.title || '')}" placeholder="What is happening?"/></div>
      <div class="form-grid">
        <div class="field"><label for="ev-type">Profile type</label><select class="input" id="ev-type" name="type">
          ${TYPES.map(t => `<option value="${t.id}" ${t.id === type ? 'selected' : ''}>${esc(t.label)}</option>`).join('')}</select></div>
        <div class="field"><label for="ev-app">App source</label><input class="input" id="ev-app" name="app" value="${esc(source)}" placeholder="calendar"/></div>
      </div>
      <div class="form-grid">
        <div class="field"><label for="ev-start-date">Start date</label><input class="input" id="ev-start-date" name="startDate" type="date" value="${esc(startValue)}"/></div>
        <div class="field"><label for="ev-end-date">End date</label><input class="input" id="ev-end-date" name="endDate" type="date" value="${esc(endValue)}"/></div>
      </div>
      <div class="form-grid time-fields" ${editing?.allDay ? 'hidden' : ''}>
        <div class="field"><label for="ev-start-time">Start time</label><input class="input" id="ev-start-time" name="startTime" type="time" value="${esc(startTime)}"/></div>
        <div class="field"><label for="ev-end-time">End time</label><input class="input" id="ev-end-time" name="endTime" type="time" value="${esc(endTime)}"/></div>
      </div>
      <label class="checkrow" style="margin-bottom:18px"><input type="checkbox" name="allDay" ${editing?.allDay ? 'checked' : ''}/> All-day event</label>
      <div class="form-grid">
        <div class="field"><label for="ev-location">Location</label><input class="input" id="ev-location" name="location" value="${esc(raw.location || '')}" placeholder="Optional"/></div>
        <div class="field"><label for="ev-category">Category</label><select class="input" id="ev-category" name="category">
          ${CATEGORIES.map(c => `<option value="${esc(c)}" ${c === (raw.category || 'General') ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></div>
      </div>
      <div class="field"><label for="ev-description">Description</label><textarea class="input" id="ev-description" name="description" placeholder="Notes for yourself">${esc(raw.description || '')}</textarea></div>
      <div class="form-error" role="alert"></div>
      <div class="modal-actions"><button type="button" class="btn" data-action="modal-close">Cancel</button>
        <button type="submit" class="btn btn-primary">${editing ? 'Save changes' : 'Create event'}</button></div>
    </form>`, true);
}

function switcherModal() {
  const st = store.state();
  const active = safeType(st.profile?.type);
  const rows = TYPES.map(t => {
    const has = st.profiles.some(p => safeType(p.type) === t.id);
    return `<button type="button" class="switch-option type-${t.id}" data-action="${has ? 'switch-profile' : 'create-profile'}" data-type="${t.id}">
      <i></i><strong>${esc(t.label)}</strong><small>${t.id === active ? 'Active' : (has ? 'Switch' : 'Create')}</small></button>`;
  }).join('');
  openModal(`${modalHead('Switch profile', 'One Atlas account, multiple calendars.')}
    <div class="switch-grid">${rows}</div>
    <p class="muted small">Switching a cloud profile may ask for your password once. It is never saved in this browser.</p>
    <div class="modal-actions"><button type="button" class="btn" data-action="modal-close">Close</button></div>`);
}

function passwordModal(type) {
  const st = store.state();
  ui.switchTarget = safeType(type);
  openModal(`${modalHead(`Switch to ${TYPE_MAP[type].label}`, 'Confirm your password once to receive the matching token.')}
    <form data-form="switch" novalidate>
      <div class="field"><label for="switch-email">Email</label><input class="input" id="switch-email" name="email" value="${esc(st.email || '')}" readonly/></div>
      <div class="field"><label for="switch-password">Password</label><input class="input" id="switch-password" name="password" type="password" autocomplete="current-password" placeholder="Your account password"/></div>
      <div class="form-error" role="alert"></div>
      <div class="modal-actions"><button type="button" class="btn" data-action="modal-close">Cancel</button>
        <button type="submit" class="btn btn-primary">Switch profile</button></div>
    </form>`);
}

function deleteConfirmModal(id) {
  ui.pendingDeleteId = id;
  openModal(`${modalHead('Delete event?', 'This removes the event from Atlas Calendar.')}
    <p class="muted small">${esc(ui.merged.find(e => e.id === id)?.title || '')}</p>
    <div class="modal-actions"><button type="button" class="btn" data-action="modal-close">Cancel</button>
      <button type="button" class="btn btn-danger" data-action="delete-event" data-id="${esc(id)}">Delete event</button></div>`);
}

/* ------------------------------ actions ------------------------------ */

async function createProfileFor(type, { stay = false, required = false } = {}) {
  const st = store.state();
  const name = `${TYPE_MAP[type].label} profile`;
  if (!st.token) {
    if (required) { clearModeParam(); ui.signupType = type; go(ROUTES.signup); return; }
    store.setLocalProfile(type, { name: st.user?.name || '' });
    toast(`${TYPE_MAP[type].label} profile created locally.`);
    closeModal();
    if (required) clearModeParam();
    go(ROUTES.overview);
    return;
  }
  const res = await api.createProfile({ type, name });
  if (res.ok) {
    applyAuth(res.data);
    closeModal();
    if (required) clearModeParam();
    toast(`${TYPE_MAP[type].label} profile ready.`);
    go(ROUTES.overview);
    startLive(true);
    return;
  }
  if (res.status === 0) {
    store.setLocalProfile(type, { name: st.user?.name || '' });
    closeModal();
    if (required) clearModeParam();
    toast('Endpoint unavailable — profile created locally.', 'error');
    go(ROUTES.overview);
    return;
  }
  toast(res.error, 'error');
  if (!stay) closeModal();
}

async function switchToProfile(type) {
  const st = store.state();
  if (safeType(st.profile?.type) === type) { closeModal(); return; }
  if (!st.profiles.some(p => safeType(p.type) === type)) { await createProfileFor(type); return; }
  if (!st.token || st.mode === 'local') {
    store.setActiveProfile(type);
    closeModal(); render(); toast(`Switched to ${TYPE_MAP[type].label} locally.`);
    return;
  }
  const res = await api.authCheck(type);
  if (res.ok && res.data?.needsSwitch === false) {
    store.setActiveProfile(type);
    closeModal(); render(); toast(`Switched to ${TYPE_MAP[type].label}.`);
    return;
  }
  if (res.ok && res.data?.needsSwitch === true) {
    closeModal(); passwordModal(type);
    return;
  }
  if (res.status === 0) {
    store.setActiveProfile(type);
    closeModal(); render(); toast('Endpoint unavailable — switched locally.', 'error');
    return;
  }
  toast(res.error, 'error');
}

async function saveEventFromForm(form, formData) {
  const allDay = formData.get('allDay') === 'on';
  const title = val(formData, 'title');
  const startDate = val(formData, 'startDate');
  const endDate = val(formData, 'endDate') || startDate;
  const startTime = val(formData, 'startTime') || '09:00';
  const endTime = val(formData, 'endTime') || '10:00';
  const start = allDay ? startDate : `${startDate}T${startTime}:00`;
  const end = allDay ? endDate : `${endDate}T${endTime}:00`;
  const source = val(formData, 'app') || 'calendar';
  const payload = {
    title, start, end, allDay,
    description: val(formData, 'description'),
    location: val(formData, 'location'),
    category: val(formData, 'category') || 'General',
    type: safeType(formData.get('type')),
    app: source,
  };
  if (source !== 'calendar') payload.sourcePrefix = source;
  const startAt = parseDate(start);
  const endAt = parseDate(end);
  if (!title) return formError(form, 'A title is required.');
  if (!startDate || !endDate || !startAt || !endAt) return formError(form, 'Enter valid start and end dates.');
  if (!allDay && endAt.getTime() <= startAt.getTime()) return formError(form, 'End time must be after start time.');
  if (allDay && endAt.getTime() < startAt.getTime()) return formError(form, 'End date must be on or after start date.');

  const editingId = ui.eventEditId;
  const localEdit = String(editingId).startsWith('local_');
  const st = store.state();
  if (st.token) {
    const res = editingId && !localEdit
      ? await api.updateEvent(editingId, payload)
      : await api.createEvent(payload);
    if (res.ok) {
      if (res.data?.event) store.cacheManualEvent(res.data.event);
      if (localEdit) store.removeManualEvent(editingId);
      closeModal(); ui.detailId = '';
      await refreshEvents();
      toast(editingId ? 'Event updated.' : 'Event created.');
      return;
    }
    if (res.status !== 0) return formError(form, res.error);
  }
  const local = {
    ...payload,
    id: editingId || uid('local'),
    _localId: editingId || uid('local'),
    manual: true,
  };
  store.cacheManualEvent(local);
  closeModal(); ui.detailId = '';
  await refreshEvents();
  toast('Saved locally — it will sync when the endpoint is available.');
}

async function handleSignup(form, formData) {
  const type = safeType(formData.get('type'));
  ui.signupType = type;
  const payload = {
    email: val(formData, 'email'), name: val(formData, 'name'),
    password: String(formData.get('password') || ''), type,
  };
  if (!/^\S+@\S+\.\S+$/.test(payload.email)) return formError(form, 'Enter a valid email address.');
  if (payload.password.length < 8) return formError(form, 'Use a password of at least 8 characters.');
  const btn = form.querySelector('button[type="submit"]');
  if (btn) btn.disabled = true;
  const res = await api.signup(payload);
  if (btn) btn.disabled = false;
  if (res.ok) {
    applyAuth(res.data);
    toast('Account created. Welcome to Atlas Calendar.');
    go(ROUTES.overview);
    return;
  }
  if (res.status === 0) {
    store.setLocalProfile(type, { name: payload.name, email: payload.email });
    toast('Cloud unavailable — continuing in local-only mode. Your password was not saved.');
    go(ROUTES.overview);
    return;
  }
  formError(form, res.error);
}

async function handleSignin(form, formData) {
  const requestedType = val(formData, 'type');
  const payload = {
    email: val(formData, 'email'),
    password: String(formData.get('password') || ''),
    ...(requestedType ? { type: requestedType } : {}),
  };
  if (!/^\S+@\S+\.\S+$/.test(payload.email)) return formError(form, 'Enter a valid email address.');
  if (!payload.password) return formError(form, 'Enter your password.');
  const btn = form.querySelector('button[type="submit"]');
  if (btn) btn.disabled = true;
  const res = await api.login(payload);
  if (btn) btn.disabled = false;
  if (res.ok) {
    applyAuth(res.data);
    if (requestedType && safeType(store.state().profile?.type) !== requestedType) {
      const url = new URL(location.href);
      url.searchParams.set('mode', requestedType);
      history.replaceState(null, '', url.pathname + url.search + ROUTES.overview);
      toast('Signed in, but that profile is not available yet.');
      routeEntered();
      return;
    }
    toast('Signed in to Atlas Calendar.');
    go(ROUTES.overview);
    return;
  }
  if (res.status === 0) {
    const fallbackType = requestedType || store.activeType() || 'personal';
    store.setLocalProfile(fallbackType, { email: payload.email });
    toast('Endpoint unavailable — opened a local-only calendar.', 'error');
    go(ROUTES.overview);
    return;
  }
  formError(form, res.error);
}

async function handleSwitch(form, formData) {
  const type = ui.switchTarget;
  const password = String(formData.get('password') || '');
  const email = val(formData, 'email') || store.state().email;
  if (!password) return formError(form, 'Enter your password to switch profiles.');
  if (!type) return formError(form, 'Choose a profile first.');
  const btn = form.querySelector('button[type="submit"]');
  if (btn) btn.disabled = true;
  const res = await api.login({ email, password, type });
  if (btn) btn.disabled = false;
  form.reset(); // password leaves the DOM as soon as the request finishes
  if (res.ok) {
    applyAuth(res.data);
    closeModal(); render(); startLive(true);
    toast(`Switched to ${TYPE_MAP[type].label}.`);
    return;
  }
  if (res.status === 0) {
    store.setActiveProfile(type);
    closeModal(); render();
    toast('Endpoint unavailable — switched locally.', 'error');
    return;
  }
  formError(form, res.error);
}

async function deleteEvent(id) {
  const st = store.state();
  const local = String(id).startsWith('local_');
  if (st.token && !local) {
    const res = await api.deleteEvent(id);
    if (!res.ok && res.status !== 0) { toast(res.error, 'error'); return; }
    if (res.status === 0) toast('Removed locally; it may return when the endpoint reconnects.', 'error');
  }
  store.removeManualEvent(id);
  ui.detailId = '';
  closeModal();
  await refreshEvents();
  toast('Event deleted.');
}

/* --------------------------- event listeners --------------------------- */

document.addEventListener('click', async e => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  if (action === 'modal-backdrop') { if (e.target === el) closeModal(); return; }
  if (action === 'modal-close') { closeModal(); return; }
  if (action === 'scroll-connect') { e.preventDefault(); $('#connects')?.scrollIntoView({ behavior: 'smooth' }); return; }
  if (action === 'sidebar-toggle') { document.body.classList.toggle('sidebar-open'); return; }
  if (action === 'close-sidebar') { document.body.classList.remove('sidebar-open'); return; }

  if (action === 'prev-period' || action === 'next-period' || action === 'today-period') {
    const st = store.state();
    const cursor = parseDate(st.settings.cursor) || new Date();
    const step = action === 'today-period' ? new Date() : (route().page === 'week' ? addDays(cursor, action === 'next-period' ? 7 : -7)
      : new Date(cursor.getFullYear(), cursor.getMonth() + (action === 'next-period' ? 1 : -1), cursor.getDate()));
    store.setSetting('cursor', dateInput(step));
    render(); await refreshEvents();
    return;
  }
  if (action === 'toggle-theme') {
    store.setSetting('theme', store.getSetting('theme') === 'paper' ? 'ink' : 'paper');
    render(); return;
  }
  if (action === 'new-event') { e.preventDefault(); document.body.classList.remove('sidebar-open'); eventModal('', el.dataset.date || dateInput(store.state().settings.cursor)); return; }
  if (action === 'open-day') { ui.dayDate = el.dataset.date || ''; ui.detailId = ''; render(); return; }
  if (action === 'event-detail') { ui.detailId = el.dataset.id || ''; ui.dayDate = ''; render(); return; }
  if (action === 'close-drawer') { ui.dayDate = ''; ui.detailId = ''; render(); return; }
  if (action === 'edit-event') { eventModal(el.dataset.id); return; }
  if (action === 'delete-confirm') { deleteConfirmModal(el.dataset.id); return; }
  if (action === 'delete-event') { await deleteEvent(el.dataset.id); return; }
  if (action === 'dismiss-onboarding') { store.setSetting('onboardingComplete', true); render(); return; }
  if (action === 'reset-onboarding') { store.setSetting('onboardingComplete', false); render(); toast('Welcome tips restored.'); return; }
  if (action === 'switch-filter') { store.setSetting('filterType', el.dataset.type || 'all'); render(); return; }
  if (action === 'switch-profile') { await switchToProfile(safeType(el.dataset.type)); return; }
  if (action === 'open-switcher') { switcherModal(); return; }
  if (action === 'open-profile-create') {
    openModal(`${modalHead('Add a profile', 'Choose the type of calendar to create.')}
      <div class="switch-grid">${TYPES.map(t => `<button type="button" class="switch-option type-${t.id}" data-action="create-profile" data-type="${t.id}"><i></i><strong>${esc(t.label)}</strong><small>${esc(t.description)}</small></button>`).join('')}</div>
      <div class="modal-actions"><button type="button" class="btn" data-action="modal-close">Cancel</button></div>`);
    return;
  }
  if (action === 'create-profile') { await createProfileFor(safeType(el.dataset.type)); return; }
  if (action === 'create-required-profile') { await createProfileFor(safeType(el.dataset.type), { required: true }); return; }
  if (action === 'goto-required-signup') {
    ui.signupType = safeType(el.dataset.type);
    clearModeParam(); go(ROUTES.signup); return;
  }
  if (action === 'back-calendar') { clearModeParam(); go(ROUTES.overview); return; }
  if (action === 'workspace') {
    e.preventDefault();
    const url = new URL(location.href);
    url.searchParams.set('mode', safeType(el.dataset.type));
    url.hash = ROUTES.overview;
    history.pushState(null, '', url.pathname + url.search + url.hash);
    routeEntered();
    return;
  }
  if (action === 'signout') {
    stopLive(); store.signOut(); clearModeParam(); document.body.classList.remove('sidebar-open');
    toast('Signed out.'); go(ROUTES.landing); return;
  }
  if (action === 'save-endpoint') {
    const input = $('#endpoint-input');
    const value = String(input?.value || '').trim();
    store.setSetting('syncEndpoint', value || 'https://atlas-sync.greenhenry441.workers.dev');
    toast('Endpoint saved.');
    startLive(true); await refreshEvents(); render();
    return;
  }
  if (action === 'refresh-derived') {
    const res = await api.refreshDerived();
    if (res.ok) { store.cacheDerived(res.data?.events || []); toast('Derived events refreshed.'); }
    else toast(res.error, 'error');
    await refreshEvents(); return;
  }
  if (action === 'snapshot-settings') {
    const s = store.state().settings;
    const res = await api.putCalendarSnapshot({ settings: s, hiddenTypes: s.hiddenTypes, theme: s.theme, timeZone: s.timeZone });
    if (res.ok) toast('Calendar settings snapshotted.');
    else toast(`Snapshot unavailable — ${res.error}`, 'error');
    return;
  }
  if (action === 'export-prefs') {
    downloadText('atlas-calendar-preferences.json', store.exportPreferences());
    toast('Preferences exported.'); return;
  }
  if (action === 'clear-data') {
    openModal(`${modalHead('Clear local data?', 'This removes local events, derived cache and preferences.')}
      <p class="muted small">Your account token and server-side events are not affected.</p>
      <div class="modal-actions"><button type="button" class="btn" data-action="modal-close">Cancel</button>
        <button type="button" class="btn btn-danger" data-action="clear-data-confirm">Clear local data</button></div>`);
    return;
  }
  if (action === 'clear-data-confirm') {
    store.clearLocalData(); closeModal(); ui.dayDate = ''; ui.detailId = '';
    await refreshEvents(); render(); toast('Local data cleared.'); return;
  }
});

document.addEventListener('submit', async e => {
  const form = e.target.closest('form[data-form]');
  if (!form) return;
  e.preventDefault();
  const fd = new FormData(form);
  const kind = form.dataset.form;
  if (kind === 'signup') await handleSignup(form, fd);
  else if (kind === 'signin') await handleSignin(form, fd);
  else if (kind === 'switch') { await handleSwitch(form, fd); }
  else if (kind === 'event') { await saveEventFromForm(form, fd); }
});

document.addEventListener('change', async e => {
  const target = e.target;
  if (target.matches('input[name="type"]')) {
    const wrap = target.closest('.type-select');
    if (wrap) {
      $$('.type-option', wrap).forEach(label => label.classList.toggle('selected', label.contains(target)));
      ui.signupType = safeType(target.value);
    }
    return;
  }
  if (target.name === 'allDay') {
    const times = target.closest('form')?.querySelector('.time-fields');
    if (times) times.hidden = target.checked;
    return;
  }
  if (target.id === 'import-file') {
    const file = target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const result = store.importPreferences(text);
      if (!result.ok) { toast(result.error, 'error'); return; }
      applyTheme(); await refreshEvents(); render(); toast('Preferences imported.');
    } catch { toast('That file could not be read.', 'error'); }
    return;
  }
  if (target.dataset?.action === 'toggle-hidden') {
    const current = store.getSetting('hiddenTypes') || [];
    const type = safeType(target.dataset.type);
    const next = target.checked ? [...new Set([...current, type])] : current.filter(t => t !== type);
    store.setSetting('hiddenTypes', next);
    render();
    return;
  }
  if (target.dataset?.action === 'setting-theme') { store.setSetting('theme', target.value); render(); return; }
  if (target.dataset?.action === 'setting-timezone') { store.setSetting('timeZone', target.value); render(); return; }
});

window.addEventListener('hashchange', routeEntered);
window.addEventListener('popstate', routeEntered);

/* ------------------------------- boot ------------------------------- */

applyTheme();
ui.events = store.state().events;
ui.derived = store.state().derived;
ui.merged = mergeEvents(ui.events, ui.derived);
ui.range = rangeForCursor(store.state().settings.cursor);
routeEntered();

/* Exposed only for smoke tests and debugging; nothing here is persisted. */
window.AtlasCalendar = { store, api, ui, refreshEvents };
