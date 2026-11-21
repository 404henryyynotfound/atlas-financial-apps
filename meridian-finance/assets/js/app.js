/* Meridian Finance — view layer, routing and interactions. */
import {
  BRAND, ROUTES, TYPE_COLORS, CURRENCIES, AI_MODELS, DEFAULT_AI_MODEL,
  AI_SYSTEM_PROMPT, SUGGESTED_WATCHLIST
} from './config.js';
import { INSTRUMENTS, INSTRUMENT_MAP, EXCHANGES } from './data.js';
import * as api from './api.js';
import * as store from './store.js';
import * as connector from './connector.js';
import * as ai from './ai.js';
import { initCalendarWidget } from './calendar-widget.js';
import { lineChart, sparkline, donut, bars, attachChartHover } from './charts.js';
import {
  $, $$, esc, money, compact, pct, num, signClass, uid, colorFor, dateLabel,
  initials, syntheticSeries, combineSeries, sliceRange, debounce, clamp
} from './utils.js';

const root = $('#app');
const modalHost = $('#modal-host');
const toastHost = $('#toast-host');

const state = {
  quotes: {}, quotesKey: '', quotesAt: 0,
  series: {}, overviews: {},
  range: '3M',
  portfolioSort: { key: 'value', dir: -1 },
  discoverType: 'All', discoverQuery: '', discoverRemote: [],
  marketRegion: 'All', marketQuery: '',
  newsCategory: 'all', newsQuery: '', newsItems: [], newsKey: '', newsAt: 0, newsLoading: false,
  landingNews: [], landingNewsKey: '', landingNewsAt: 0,
  searchTerm: '', searchResults: [], searchSelected: 0, searchOpen: false,
  authMode: 'signin', article: null,
  aiMessages: [], aiBusy: false, aiProgress: null, aiError: '',
  aiContext: { portfolio: true, watchlist: true, news: true },
  aiPrefill: '',
  onboarding: { theme: 'dark', watchlist: [] },
  connector: {
    connected: false, code: '', expiresAt: null, user: null,
    lastSyncAt: null, lastRemoteUpdatedAt: '', message: '', messageKind: 'error',
    busy: false, pushFailed: false,
  },
};

let cloudUnsubscribe = null;
let applyingRemote = false;

/* ---------------------------- helpers ---------------------------- */

function route() {
  const hash = (location.hash || '#/').replace(/\/$/, '') || '#/';
  if (hash.startsWith('#/app/')) {
    const parts = hash.split('/');
    return { mode: 'app', page: parts[2] || 'overview', param: decodeURIComponent(parts[3] || '') };
  }
  if (hash === '#/login') return { mode: 'login' };
  return { mode: 'landing' };
}

function go(hash, preserve = false) {
  if (location.hash === hash) render({ preserve });
  else location.hash = hash;
}

function currency() { return store.getPrefs().currency || 'USD'; }
function fmt(value, digits) { return money(value, currency(), digits != null ? { digits } : undefined); }

function demoQuote(symbol) {
  const inst = INSTRUMENT_MAP[String(symbol || '').toUpperCase()];
  const price = inst?.price || 100;
  return { symbol, price, changePct: inst?.changePct || 0, change: price * (inst?.changePct || 0) / 100, live: false };
}

function priceFor(symbol) { return state.quotes[symbol] || demoQuote(symbol); }

function instrumentFor(symbol) {
  return INSTRUMENT_MAP[String(symbol || '').toUpperCase()] || {
    symbol, name: symbol, type: 'Stock', exchange: 'Other', sector: 'Other',
    currency: currency(), color: colorFor(symbol), initial: String(symbol || '?')[0].toUpperCase(),
  };
}

function symLogo(symbol, size = '') {
  const inst = instrumentFor(symbol);
  return `<span class="sym-logo ${size}" style="background:${inst.color || colorFor(symbol)}">${esc((symbol || '?')[0].toUpperCase())}</span>`;
}

function metrics() {
  const d = store.data();
  const rows = d.holdings.map(h => {
    const inst = instrumentFor(h.symbol);
    const q = priceFor(h.symbol);
    const price = Number(q.price) || 0;
    const changePct = Number(q.changePct) || 0;
    const value = price * Number(h.quantity || 0);
    const cost = Number(h.avgCost || 0) * Number(h.quantity || 0);
    return {
      ...h, ...inst, price, changePct,
      dayChange: value * changePct / 100,
      value, cost, gain: value - cost,
      gainPct: cost ? (value - cost) / cost * 100 : 0,
      weight: 0,
    };
  });
  const total = rows.reduce((s, r) => s + r.value, 0);
  const cost = rows.reduce((s, r) => s + r.cost, 0);
  const day = rows.reduce((s, r) => s + r.dayChange, 0);
  rows.forEach(r => { r.weight = total ? r.value / total * 100 : 0; });
  return {
    rows, total, cost, day, dayPct: total - day ? day / (total - day) * 100 : 0,
    gain: total - cost, gainPct: cost ? (total - cost) / cost * 100 : 0,
  };
}

function seriesFor(symbol, days = 252) {
  const cached = state.series[symbol]?.items;
  if (cached?.length) return cached;
  const q = priceFor(symbol);
  return syntheticSeries(symbol, q.price || 100, days, q.changePct || 0.6);
}

function performanceSeries() {
  const m = metrics();
  if (!m.rows.length) {
    return syntheticSeries('SPY', 100, 252, 8).map(p => ({ date: p.date, value: p.close }));
  }
  const bySymbol = {};
  const weights = {};
  m.rows.slice(0, 10).forEach(r => {
    bySymbol[r.symbol] = seriesFor(r.symbol);
    weights[r.symbol] = r.value;
  });
  return combineSeries(bySymbol, weights);
}

function toast(message, type = 'success') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span class="ic">${type === 'error' ? '⚠' : '✓'}</span><span>${esc(message)}</span>`;
  toastHost.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateY(8px)'; }, 3200);
  setTimeout(() => el.remove(), 3600);
}

function openModal(html, wide = false) {
  modalHost.innerHTML = `<div class="overlay" data-action="modal-backdrop"><div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">${html}</div></div>`;
  document.body.style.overflow = 'hidden';
  const first = modalHost.querySelector('input, select, textarea, button');
  if (first) setTimeout(() => first.focus(), 40);
}

function closeModal() { modalHost.innerHTML = ''; document.body.style.overflow = ''; }

function modalHead(title, sub = '') {
  return `<div class="modal-head"><div><h2>${esc(title)}</h2>${sub ? `<p>${esc(sub)}</p>` : ''}</div>
    <button class="btn btn-icon btn-ghost" data-action="modal-close" aria-label="Close">✕</button></div>`;
}

function confirmModal({ title, body, action, id }) {
  openModal(`${modalHead(title)}<p class="muted small">${esc(body)}</p>
    <div class="modal-actions"><button class="btn" data-action="modal-close">Cancel</button>
    <button class="btn btn-danger" data-action="${action}" data-id="${esc(id)}">Confirm</button></div>`);
}

/* ---------------------------- async loaders ---------------------------- */

async function ensureQuotes(force = false) {
  const d = store.data();
  const r = route();
  const symbols = [
    ...d.holdings.map(h => h.symbol), ...d.watchlist,
    ...(r.page === 'markets' ? ['SPY', 'QQQ', 'GLD', 'TLT', 'VTI'] : []),
    ...(r.page === 'discover' ? INSTRUMENTS.slice(0, 8).map(i => i.symbol) : []),
    ...(r.page === 'instrument' && r.param ? [r.param] : []),
  ];
  const unique = [...new Set(symbols.filter(Boolean))];
  const key = unique.slice().sort().join(',');
  const sessionKey = sessionStorage.getItem('meridian.quotes.session');
  const sessionHit = !force && sessionKey === key && Date.now() - Number(sessionStorage.getItem('meridian.quotes.sessionAt') || 0) < 30 * 60000;
  if (!force && (key === state.quotesKey && Date.now() - state.quotesAt < 5 * 60000 || sessionHit)) return;
  state.quotesKey = key;
  state.quotesAt = Date.now();
  sessionStorage.setItem('meridian.quotes.session', key);
  sessionStorage.setItem('meridian.quotes.sessionAt', String(Date.now()));
  if (!unique.length) return;
  const quotes = await api.getQuotes(unique, { force, limit: 14 });
  state.quotes = { ...state.quotes, ...quotes };
  render({ preserve: true });
}

async function ensureSeries(symbol) {
  if (!symbol) return;
  if (state.series[symbol] && Date.now() - state.series[symbol].at < 12 * 3600000) return;
  state.series[symbol] = { at: Date.now(), items: seriesFor(symbol) };
  const items = await api.getDailySeries(symbol);
  state.series[symbol] = { at: Date.now(), items };
  render({ preserve: true });
}

async function ensureOverview(symbol) {
  if (!symbol || state.overviews[symbol]) return;
  state.overviews[symbol] = {};
  const info = await api.getOverview(symbol);
  state.overviews[symbol] = info || {};
  render({ preserve: true });
}

function newsQueryFor(category) {
  if (!category || category === 'all') return 'stock market';
  if (category === 'foryou') {
    const syms = store.data().holdings.slice(0, 4).map(h => h.symbol);
    return syms.length ? `${syms.join(' OR ')} earnings` : 'stock market';
  }
  return { macro: 'economy inflation interest rates', earnings: 'company earnings results', funds: 'ETFs mutual funds investing', global: 'global markets international stocks', learn: 'investing for beginners portfolio' }[category] || 'stock market';
}

async function ensureNews(force = false) {
  if (route().page !== 'news') return;
  const key = `${state.newsCategory}:${state.newsQuery || newsQueryFor(state.newsCategory)}`;
  if (!force && key === state.newsKey && Date.now() - state.newsAt < 20 * 60000) return;
  state.newsKey = key;
  state.newsAt = Date.now();
  state.newsLoading = true;
  const items = await api.getNews({ query: state.newsQuery || newsQueryFor(state.newsCategory), category: state.newsCategory, force });
  state.newsItems = items;
  state.newsLoading = false;
  render({ preserve: true });
}

async function ensureLandingNews() {
  if (state.landingNews.length && Date.now() - state.landingNewsAt < 20 * 60000) return;
  state.landingNewsKey = 'loading';
  const items = await api.getNews({ query: 'stock market today', category: 'all' });
  state.landingNews = items.slice(0, 3);
  state.landingNewsAt = Date.now();
  state.landingNewsKey = 'done';
  render({ preserve: true });
}

/* ---------------------------- shell ---------------------------- */

function brandMarkup(small = false) {
  return `<span class="brand"><span class="brand-mark">M</span><span class="brand-name">${esc(BRAND.product)}${small ? '' : `<span class="brand-sub">by ${esc(BRAND.legal)}</span>`}</span></span>`;
}

function navItem(page, icon, label) {
  const active = route().mode === 'app' && route().page === page;
  return `<a class="nav-item ${active ? 'active' : ''}" href="#/app/${page}" data-action="nav"><span class="ico">${icon}</span><span class="label">${label}</span></a>`;
}

function sidebar() {
  const user = store.currentUser();
  return `<aside class="sidebar">
    ${brandMarkup()}
    <div>
      <p class="nav-group-label">Workspace</p>
      <nav class="side-nav">
        ${navItem('overview', '◫', 'Overview')}
        ${navItem('portfolio', '▤', 'Portfolio')}
        ${navItem('watchlist', '☆', 'Watchlist')}
        ${navItem('goals', '◎', 'Goals')}
      </nav>
    </div>
    <div>
      <p class="nav-group-label">Intelligence</p>
      <nav class="side-nav">
        ${navItem('discover', '⌕', 'Discover')}
        ${navItem('markets', '◉', 'Markets')}
        ${navItem('news', '▧', 'News')}
        ${navItem('ai', '✦', 'Meridian AI')}
        ${navItem('settings', '⚙', 'Settings')}
      </nav>
    </div>
    <div class="sidebar-bottom">
      <div class="side-account"><span class="avatar">${esc(initials(user?.name || 'Investor'))}</span>
        <span class="details"><span class="name">${esc(user?.name || 'Investor')}</span><span class="mail">${esc(user?.email || '')}</span></span></div>
      <p class="side-note">${esc(BRAND.dba)} is a trade name of ${esc(BRAND.legal)}. Local-first data.</p>
    </div>
  </aside>`;
}

function topbar() {
  const open = isMarketOpen();
  return `<header class="topbar">
    <button class="btn btn-icon btn-ghost mobile-menu" data-action="toggle-mobile-nav">☰</button>
    <div class="global-search">
      <div class="search-input-wrap"><span>⌕</span><input id="global-search" autocomplete="off" placeholder="Search tickers, funds, exchanges…" value="${esc(state.searchTerm)}"/>
        <span class="kbd">⌘ K</span></div>
      ${state.searchOpen ? `<div class="search-results" id="search-results">${searchResultsMarkup()}</div>` : ''}
    </div>
    <div class="topbar-right">
      <div class="market-status"><span class="status-dot ${open ? '' : 'closed'}"></span>${open ? 'US markets open' : 'Markets closed'}</div>
      <button class="btn btn-icon btn-ghost" data-action="toggle-theme" title="${store.getPrefs().theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme'}">${store.getPrefs().theme === 'light' ? '◐' : '☀'}</button>
      <button class="btn btn-sm" data-action="refresh" title="Refresh prices">↻ <span class="small">Refresh</span></button>
      <button class="btn btn-primary btn-sm" data-action="add-holding">＋ Add investment</button>
    </div>
  </header>`;
}

function isMarketOpen() {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = et.getDay();
  const mins = et.getHours() * 60 + et.getMinutes();
  return day >= 1 && day <= 5 && mins >= 570 && mins < 960;
}

function searchResultsMarkup() {
  if (!state.searchTerm.trim()) {
    return `<div class="search-result muted small">Try “AAPL”, “Vanguard” or “Toyota”.</div>` +
      INSTRUMENTS.slice(0, 4).map(i => searchResultRow(i)).join('');
  }
  if (!state.searchResults.length) return `<div class="search-result muted small">No matches. Press Enter to search global exchanges.</div>`;
  return state.searchResults.slice(0, 9).map((r, i) => searchResultRow(r, i === state.searchSelected)).join('');
}

function searchResultRow(r, selected = false) {
  return `<div class="search-result ${selected ? 'selected' : ''}" data-action="search-result" data-symbol="${esc(r.symbol)}">
    ${symLogo(r.symbol)}<span class="sym">${esc(r.symbol)}</span><span class="nm">${esc(r.name)}</span>
    <span class="tag-pill">${esc(r.exchange || '')}</span></div>`;
}

/* ---------------------------- landing ---------------------------- */

function landing() {
  const movers = INSTRUMENTS.filter(i => ['NVDA', 'AAPL', 'MSFT', 'TSM', 'ARKK', 'GLD'].includes(i.symbol));
  const demoSeries = syntheticSeries('MERIDIAN', 100, 120, 14.6).map(p => ({ date: p.date, value: p.close }));
  const news = state.landingNews;
  return `<div class="landing">
    <div class="nav-wrap"><nav class="nav">
      ${brandMarkup()}
      <div class="nav-links"><a href="#features">Features</a><a href="#markets">Markets</a><a href="#newsroom">Newsroom</a><a href="#about">About</a></div>
      <div class="nav-actions"><button class="btn btn-ghost btn-sm" data-action="go-login">Sign in</button>
        <button class="btn btn-primary btn-sm" data-action="go-signup">Get started — free</button></div>
    </nav></div>

    <section class="hero">
      <div>
        <span class="eyebrow"><span class="pulse-dot"></span> A product of ${esc(BRAND.legal)}</span>
        <h1>Every market.<br><em>One clear view.</em></h1>
        <p class="hero-copy">${esc(BRAND.dba)} brings stocks, funds, exchanges and the news that moves them into one beautifully calm workspace. Track everything you own — in one place.</p>
        <div class="hero-ctas">
          <button class="btn btn-primary btn-lg" data-action="go-signup">Start building your portfolio →</button>
          <button class="btn btn-lg" data-action="demo">Explore the live demo</button>
        </div>
        <div class="hero-note"><span>✓ No credit card</span><span>✓ Private by design</span><span>✓ On-device AI</span></div>
      </div>
      <div class="hero-visual">
        <div class="hero-glow"></div>
        <div class="mock-card">
          <div class="mock-top"><span>PORTFOLIO OVERVIEW</span><span class="num">NOV 2026</span></div>
          <div class="mock-value">$284,619.42</div>
          <div class="mock-change">↗ +$3,182.60 (1.13%) today</div>
          <div class="mock-chart">${lineChart(demoSeries, { height: 150, color: '#4fd1c5' })}</div>
          <div class="mock-rows">
            ${movers.map(i => `<div class="mock-row"><span class="sym"><span class="sym-badge" style="background:${i.color}">${esc(i.symbol[0])}</span>${esc(i.symbol)}</span>
              <span class="${signClass(i.changePct)} num">${pct(i.changePct)}</span></div>`).join('')}
          </div>
        </div>
        <div class="float-chip one"><span class="dot"></span> Live prices · 40+ exchanges</div>
        <div class="float-chip two">✦ Meridian Pulse insights</div>
      </div>
    </section>

    <div class="ticker-band"><div class="ticker-track">
      ${[...movers, ...movers].map(i => `<span class="ticker-item"><b>${esc(i.symbol)}</b><span class="${signClass(i.changePct)}">${pct(i.changePct)}</span></span>`).join('')}
    </div></div>

    <section class="section" id="features">
      <div class="section-head"><span class="eyebrow">THE PLATFORM</span><h2>Everything in one field of view.</h2>
        <p>Not just a tracker — a complete command center for the way you actually invest.</p></div>
      <div class="feature-grid">
        ${[
          ['◫', 'One portfolio, every asset', 'Stocks, ETFs, mutual funds, bonds, crypto, REITs and commodities side by side. Add any ticker you own.'],
          ['✦', 'Meridian AI', 'An on-device assistant that explains your portfolio, summaries and headlines locally — no API key, no quota.'],
          ['⌕', 'Global discovery', 'Search across 40+ exchanges and thousands of instruments with live symbol lookup and fundamentals.'],
          ['▧', 'News with context', 'Follow the headlines that touch your holdings, with topic filters and a reading list built around you.'],
          ['◈', 'Meridian Pulse', 'Instant read on concentration, diversification and the positions driving today’s result.'],
          ['◎', 'Goals that connect', 'Tie your progress to real targets — a home, a milestone, financial independence.'],
          ['◇', 'Private by default', 'Your local accounts and portfolio data stay in your browser. Export or import whenever you like.'],
        ].map(([ic, t, p]) => `<article class="feature"><div class="feature-icon">${ic}</div><h3>${esc(t)}</h3><p>${esc(p)}</p></article>`).join('')}
      </div>
    </section>

    <section class="section split-section" id="markets">
      <div>
        <span class="eyebrow">COVERAGE</span>
        <h2>From New York to Tokyo. From shares to funds.</h2>
        <p class="muted" style="margin-top:16px">Browse the exchanges that set the world's prices, then drill into any instrument with real quotes and history.</p>
        <div class="asset-cloud">${['Stocks','ETFs','Mutual Funds','Bonds','Crypto','Commodities','REITs','ADRs'].map(a => `<span class="asset-chip"><b>${a}</b></span>`).join('')}</div>
        <div class="btn-row" style="margin-top:28px"><button class="btn btn-primary" data-action="demo">Open the markets</button></div>
      </div>
      <div class="market-grid">${EXCHANGES.slice(0, 8).map(e => `<div class="market-tile"><div class="flag">${e.flag}</div><strong>${esc(e.name)}</strong><span>${esc(e.city)} · ${esc(e.classes.join(' · '))}</span></div>`).join('')}</div>
    </section>

    <section class="section" id="newsroom">
      <div class="section-head"><span class="eyebrow">NEWSROOM</span><h2>Markets move. Stay informed.</h2>
        <p>A focused feed of what's happening across equities, funds and the wider economy.</p></div>
      <div class="news-preview">
        ${news.length ? news.map(n => `<a class="preview-card" href="${esc(n.url)}" target="_blank" rel="noopener"><span class="tag">${esc(n.source || 'Markets')}</span>
          <div><h3>${esc(n.title)}</h3><p>${esc(n.summary || 'Open the story for the full briefing.')}</p></div>
          <span class="meta">${esc(dateLabel(n.published, { relative: true }))} · ${n.demo ? 'Sample briefing' : 'Live headline'}</span></a>`).join('')
          : [0,1,2].map(() => `<div class="preview-card"><span class="tag">Loading</span><div class="mock-rows"><div class="mock-row"></div><div class="mock-row"></div></div><span class="meta">Fetching the latest briefing…</span></div>`).join('')}
      </div>
    </section>

    <section class="section" style="padding-top:0"><div class="cta-band" id="about">
      <span class="eyebrow">YOUR NEXT MOVE</span><h2>Clarity is a competitive advantage.</h2>
      <p>See every position, every market and every headline in one calm, considered space. Built by ${esc(BRAND.legal)}.</p>
      <div class="btn-row" style="justify-content:center"><button class="btn btn-primary btn-lg" data-action="go-signup">Create your free account</button><button class="btn btn-lg" data-action="demo">Try the demo</button></div>
    </div></section>

    <footer class="landing-footer"><div class="footer-inner">
      <div>${brandMarkup()}<p>${esc(BRAND.dba)} is a trade name of ${esc(BRAND.legal)}. Market data provided by Alpha Vantage; headlines via Google News. For informational purposes only — not financial advice.</p></div>
      <div class="footer-links"><a href="#features">Features</a><a href="#markets">Markets</a><a href="#newsroom">News</a><button class="btn btn-ghost btn-sm" data-action="go-login">Sign in</button></div>
    </div></footer>
  </div>`;
}

/* ---------------------------- auth ---------------------------- */

function authPage() {
  const signup = state.authMode === 'signup';
  return `<div class="auth-page">
    <div class="auth-form-side"><div class="auth-box">
      <a href="#/" class="brand" style="margin-bottom:28px"><span class="brand-mark">M</span><span class="brand-name">${esc(BRAND.product)}<span class="brand-sub">by ${esc(BRAND.legal)}</span></span></a>
      <h1>${signup ? 'Create your account' : 'Welcome back'}</h1>
      <p class="sub">${signup ? 'Start seeing your whole financial picture.' : 'Your portfolio is right where you left it.'}</p>
      <form id="${signup ? 'signup' : 'signin'}-form">
        ${signup ? `<div class="field"><label for="name">Your name</label><input class="input" id="name" name="name" placeholder="Alex Morgan" required/></div>` : ''}
        <div class="field"><label for="email">Email address</label><input class="input" type="email" id="email" name="email" placeholder="you@example.com" required/></div>
        <div class="field"><label for="password">Password</label><input class="input" type="password" id="password" name="password" placeholder="${signup ? 'At least 8 characters' : '••••••••'}" required/></div>
        <div class="form-error" id="auth-error"></div>
        <button class="btn btn-primary btn-lg" style="width:100%" type="submit">${signup ? 'Create account →' : 'Sign in →'}</button>
      </form>
      <div class="or-line">or</div>
      <button class="btn" style="width:100%" data-action="demo">Explore with a demo account</button>
      <p class="auth-switch">${signup ? 'Already have an account?' : 'New to Meridian?'} <a href="#" data-action="auth-mode" data-mode="${signup ? 'signin' : 'signup'}">${signup ? 'Sign in' : 'Create one free'}</a></p>
      <p class="tiny faint center" style="margin-top:22px">Accounts are stored privately in this browser.</p>
    </div></div>
    <div class="auth-art"><div>
      <span class="eyebrow"><span class="pulse-dot"></span> ${esc(BRAND.legal)} presents</span>
      <h2 style="margin-top:20px">The whole market, finally in focus.</h2>
      <p>One workspace for everything you own and everything you're watching — with the news that connects the dots.</p>
      <div class="auth-points">
        <div class="auth-point"><span class="tick">✓</span><span>Track unlimited investments across any asset class</span></div>
        <div class="auth-point"><span class="tick">✓</span><span>Live quotes and historical charts from Alpha Vantage</span></div>
        <div class="auth-point"><span class="tick">✓</span><span>Meridian AI runs locally with no API key or usage cap</span></div>
        <div class="auth-point"><span class="tick">✓</span><span>Your data stays private, portable and yours</span></div>
      </div>
    </div></div>
  </div>`;
}

/* ---------------------------- app pages ---------------------------- */

function pageHead(title, sub, actions = '', crumbs = '') {
  return `<div class="page-head"><div>${crumbs ? `<div class="crumbs">${crumbs}</div>` : ''}<h1>${title}</h1><p>${sub}</p></div><div class="btn-row">${actions}</div></div>`;
}

function overviewPage() {
  const m = metrics();
  const d = store.data();
  const user = store.currentUser();
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const chart = lineChart(sliceRange(performanceSeries(), state.range), {
    height: 280, currency: currency(), color: m.gain >= 0 ? '#4fd1c5' : '#fb7185'
  });
  const byType = Object.values(m.rows.reduce((acc, r) => {
    acc[r.type] = acc[r.type] || { label: r.type, value: 0, color: TYPE_COLORS[r.type] || colorFor(r.type) };
    acc[r.type].value += r.value;
    return acc;
  }, {}));
  const movers = [...m.rows].sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct)).slice(0, 5);
  const watch = d.watchlist.slice(0, 5);
  const apiState = api.apiStatus();
  const top = [...m.rows].sort((a, b) => b.weight - a.weight)[0];
  const concentration = top?.weight > 35;
  const sectors = new Set(m.rows.map(r => r.sector)).size;

  return `${pageHead(`${esc(greet)}, ${esc(user?.name?.split(' ')[0] || 'Investor')}`,
    `${esc(dateLabel(Date.now()))} · Here's how your portfolio is moving.`,
    `<button class="btn" data-action="refresh">↻ Refresh prices</button><button class="btn btn-primary" data-action="add-holding">＋ Add investment</button>`)}
    <div class="grid grid-4" style="margin-bottom:18px">
      <div class="card stat-card hero-card"><div class="stat-label">Total portfolio value</div>
        <div class="hero-value">${esc(fmt(m.total))}</div>
        <div class="hero-meta"><span class="badge ${signClass(m.day)}">${m.day >= 0 ? '↗' : '↘'} ${esc(fmt(Math.abs(m.day)))} (${pct(m.dayPct)})</span><span class="faint tiny">today</span></div></div>
      <div class="card stat-card"><div class="stat-label">Total return</div><div class="stat-value ${signClass(m.gain)}">${esc(fmt(m.gain))}</div>
        <div class="stat-foot"><span class="${signClass(m.gainPct)}">${pct(m.gainPct)}</span> on ${esc(fmt(m.cost))} invested</div></div>
      <div class="card stat-card"><div class="stat-label">Positions</div><div class="stat-value">${m.rows.length}</div>
        <div class="stat-foot">Across ${sectors || 0} sectors · ${new Set(m.rows.map(r => r.type)).size} asset classes</div></div>
      <div class="card stat-card"><div class="stat-label">Top position</div><div class="stat-value" style="font-size:22px">${esc(top?.symbol || '—')}</div>
        <div class="stat-foot">${top ? `${top.weight.toFixed(1)}% of portfolio` : 'Add a holding to begin'}</div></div>
    </div>

    <div class="grid grid-main" style="margin-bottom:18px">
      <div class="card"><div class="card-head"><div><h3>Portfolio performance</h3><div class="card-sub">Weighted across your holdings · ${esc(currency())}</div></div>
        <div class="segmented">${['1M','3M','6M','1Y'].map(r => `<button class="${state.range === r ? 'active' : ''}" data-action="range" data-range="${r}">${r}</button>`).join('')}</div></div>
        ${chart}<div class="data-note">◈ ${apiState.remaining} of ${apiState.limit} live requests remaining today. Cached data is used after that.</div></div>
      <div class="card"><div class="card-head"><div><h3>Allocation</h3><div class="card-sub">By asset class</div></div></div>
        ${byType.length ? `<div style="display:flex;align-items:center;gap:18px;flex-wrap:wrap">${donut(byType, { size: 168, thickness: 17, label: 'Total', value: compact(m.total, currency() === 'USD' ? '$' : '') })}
          <div style="flex:1;min-width:130px;display:grid;gap:9px">${byType.sort((a,b)=>b.value-a.value).map(s => `<div style="display:flex;align-items:center;gap:8px;font-size:12px">
            <span style="width:9px;height:9px;border-radius:3px;background:${s.color}"></span><span class="muted" style="flex:1">${esc(s.label)}</span>
            <b class="num">${m.total ? (s.value / m.total * 100).toFixed(0) : 0}%</b></div>`).join('')}</div></div>`
          : `<div class="empty"><div class="big">◫</div><h3>No allocations yet</h3><p>Add your first investment and your breakdown will appear here.</p><button class="btn btn-primary btn-sm" data-action="add-holding">Add investment</button></div>`}
      </div>
    </div>

    <div class="grid grid-2" style="margin-bottom:18px">
      <div class="card"><div class="card-head"><h3>Today's movers</h3><button class="btn btn-ghost btn-sm" data-action="nav" href="#/app/portfolio">View all →</button></div>
        ${movers.length ? `<div class="table-scroll"><table class="data"><thead><tr><th>Instrument</th><th>Price</th><th>Day</th><th>Value</th></tr></thead><tbody>
          ${movers.map(r => `<tr style="cursor:pointer" data-action="open-instrument" data-symbol="${esc(r.symbol)}"><td><div class="sym-cell">${symLogo(r.symbol)}<div><strong>${esc(r.symbol)}</strong><small>${esc(r.name)}</small></div></div></td>
            <td class="num">${esc(fmt(r.price))}</td><td class="${signClass(r.changePct)} num">${pct(r.changePct)}</td><td class="num">${esc(fmt(r.value))}</td></tr>`).join('')}
        </tbody></table></div>` : emptyMini('No holdings to rank yet.')}</div>
      <div class="card"><div class="card-head"><h3>Around your markets</h3><button class="btn btn-ghost btn-sm" data-action="nav" href="#/app/news">All news →</button></div>
        ${state.newsItems.length ? state.newsItems.slice(0, 4).map(n => `<a class="news-card" style="border:0;padding:10px 0;background:none" href="${esc(n.url)}" target="_blank" rel="noopener">
          <span class="kicker">${esc(n.source || 'Markets')} ${n.demo ? '· sample' : ''}</span><h3 style="font-size:14px">${esc(n.title)}</h3>
          <span class="meta">${esc(dateLabel(n.published, { relative: true }))}</span></a>`).join('')
          : [0,1,2].map(() => `<div class="mock-row" style="margin-bottom:8px;height:44px"></div>`).join('')}
      </div>
    </div>

    <div class="grid grid-2">
      <div class="card"><div class="card-head"><h3>Meridian Pulse</h3><div class="btn-row"><span class="badge neutral">Insights</span>
        <button class="btn btn-sm" data-action="ai-prompt" data-prompt="Summarize my portfolio in plain English and explain the main drivers of today's result.">✦ Ask AI</button></div></div>
        <div class="stack" style="gap:10px">
          <div class="insight"><span class="ic">${concentration ? '⚠' : '✓'}</span><div><strong>${concentration ? 'Concentration watch' : 'Balanced exposure'}</strong>
            <p>${top ? `Your largest position, ${esc(top.symbol)}, is ${top.weight.toFixed(1)}% of the portfolio. ${concentration ? 'Consider whether that matches your risk plan.' : 'No single holding dominates the book.'}` : 'Add holdings to unlock concentration analysis.'}</p></div></div>
          <div class="insight"><span class="ic">◈</span><div><strong>${sectors >= 4 ? 'Healthy sector spread' : 'Room to diversify'}</strong>
            <p>${sectors ? `You're spread across ${sectors} sectors and ${new Set(m.rows.map(r=>r.type)).size} asset classes.` : 'Broaden across sectors to smooth out market-specific swings.'}</p></div></div>
          <div class="insight"><span class="ic">↗</span><div><strong>Best day performer</strong>
            <p>${movers.length ? `${esc(movers[0].symbol)} is ${pct(movers[0].changePct)} today, contributing ${esc(fmt(movers[0].dayChange))}.` : 'Waiting for market data.'}</p></div></div>
        </div></div>
      <div class="card"><div class="card-head"><h3>Watchlist</h3><button class="btn btn-ghost btn-sm" data-action="nav" href="#/app/watchlist">Manage →</button></div>
        ${watch.length ? watch.map(sym => {
          const q = priceFor(sym); const inst = instrumentFor(sym);
          return `<div class="mock-row" style="cursor:pointer" data-action="open-instrument" data-symbol="${esc(sym)}">
            <span class="sym">${symLogo(sym)} <b>${esc(sym)}</b><span class="faint tiny">${esc(inst.name)}</span></span>
            <span><b class="num">${esc(fmt(q.price))}</b> <span class="${signClass(q.changePct)} tiny">${pct(q.changePct)}</span></span></div>`;
        }).join('') : `<div class="empty"><div class="big">☆</div><h3>Nothing on watch</h3><p>Save instruments you're researching to follow them here.</p><button class="btn btn-sm" data-action="nav" href="#/app/discover">Browse markets</button></div>`}
      </div>
    </div>`;
}

function portfolioPage() {
  const m = metrics();
  const d = store.data();
  const sort = state.portfolioSort;
  const rows = [...m.rows].sort((a, b) => {
    const av = a[sort.key], bv = b[sort.key];
    return (typeof av === 'string' ? av.localeCompare(bv) : av - bv) * sort.dir;
  });
  const sectorTotals = Object.values(m.rows.reduce((acc, r) => {
    acc[r.sector] = (acc[r.sector] || 0) + r.value; return acc;
  }, {})).map((v, i) => ({ label: [...new Set(m.rows.map(r => r.sector))][i], value: v, color: colorFor([...new Set(m.rows.map(r => r.sector))][i]) })).sort((a, b) => b.value - a.value).slice(0, 8);
  const headers = [['symbol','Instrument'],['price','Price'],['changePct','Day'],['quantity','Quantity'],['avgCost','Avg cost'],['value','Value'],['gain','Total return'],['weight','Weight']];

  return `${pageHead('Your portfolio', 'Every position, measured in one place.',
    `<button class="btn" data-action="export">↧ Export</button><button class="btn btn-primary" data-action="add-holding">＋ Add investment</button>`)}
    <div class="grid grid-4" style="margin-bottom:18px">
      <div class="card stat-card"><div class="stat-label">Market value</div><div class="stat-value">${esc(fmt(m.total))}</div><div class="stat-foot">${m.rows.length} positions</div></div>
      <div class="card stat-card"><div class="stat-label">Cost basis</div><div class="stat-value">${esc(fmt(m.cost))}</div><div class="stat-foot">What you paid</div></div>
      <div class="card stat-card"><div class="stat-label">Unrealised return</div><div class="stat-value ${signClass(m.gain)}">${esc(fmt(m.gain))}</div><div class="stat-foot"><span class="${signClass(m.gainPct)}">${pct(m.gainPct)}</span> overall</div></div>
      <div class="card stat-card"><div class="stat-label">Day change</div><div class="stat-value ${signClass(m.day)}">${esc(fmt(m.day))}</div><div class="stat-foot"><span class="${signClass(m.dayPct)}">${pct(m.dayPct)}</span> since previous close</div></div>
    </div>
    <div class="card" style="margin-bottom:18px">
      <div class="card-head"><div><h3>Holdings</h3><div class="card-sub">Click a column to sort · click a row for details</div></div><span class="badge neutral">${m.rows.length} positions</span></div>
      ${rows.length ? `<div class="table-scroll"><table class="data"><thead><tr>
        ${headers.map(([key, label]) => `<th class="sortable ${sort.key === key ? 'up' : ''}" data-action="sort" data-key="${key}">${label}${sort.key === key ? (sort.dir === -1 ? ' ↓' : ' ↑') : ''}</th>`).join('')}<th></th></tr></thead><tbody>
        ${rows.map(r => `<tr>
          <td><div class="sym-cell" style="cursor:pointer" data-action="open-instrument" data-symbol="${esc(r.symbol)}">${symLogo(r.symbol)}<div><strong>${esc(r.symbol)}</strong><small>${esc(r.name)}</small></div></div></td>
          <td class="num">${esc(fmt(r.price))}</td>
          <td class="num ${signClass(r.changePct)}">${pct(r.changePct)}</td>
          <td class="num">${num(r.quantity, r.quantity < 10 ? 4 : 0)}</td>
          <td class="num">${esc(fmt(r.avgCost))}</td>
          <td class="num"><b>${esc(fmt(r.value))}</b></td>
          <td class="num ${signClass(r.gain)}">${esc(fmt(r.gain))}<br><span class="tiny">${pct(r.gainPct)}</span></td>
          <td class="num">${r.weight.toFixed(1)}%<br>${sparkline(seriesFor(r.symbol, 30).slice(-30).map(p => p.close), { width: 68, height: 20 })}</td>
          <td><div class="btn-row" style="justify-content:flex-end"><button class="btn btn-icon btn-sm" data-action="edit-holding" data-id="${esc(r.id)}" title="Edit">✎</button>
            <button class="btn btn-icon btn-sm btn-danger" data-action="delete-holding" data-id="${esc(r.id)}" title="Remove">✕</button></div></td>
        </tr>`).join('')}
      </tbody></table></div>` : `<div class="empty"><div class="big">▤</div><h3>Your book is empty</h3><p>Add a stock, fund or any other investment to start tracking it.</p><button class="btn btn-primary" data-action="add-holding">Add your first investment</button></div>`}
    </div>
    <div class="grid grid-side">
      <div class="card"><div class="card-head"><h3>Sector exposure</h3><div class="card-sub">By market value</div></div>${sectorTotals.length ? bars(sectorTotals.map(s => ({ ...s, display: `${(s.value / (m.total||1) * 100).toFixed(0)}%` }))) : emptyMini('Add holdings to see exposure.')}</div>
      <div class="card"><div class="card-head"><h3>Transaction history</h3><span class="badge neutral">${d.transactions.length} recorded</span></div>
        ${d.transactions.length ? `<div class="table-scroll"><table class="data"><thead><tr><th>Date</th><th>Instrument</th><th>Type</th><th>Quantity</th><th>Price</th><th></th></tr></thead><tbody>
          ${[...d.transactions].sort((a,b)=>b.date-a.date).slice(0, 10).map(tx => `<tr><td class="muted">${esc(dateLabel(tx.date, { year: false }))}</td>
            <td><b>${esc(tx.symbol)}</b></td><td><span class="badge ${tx.type === 'Sell' ? 'down' : 'up'}">${esc(tx.type)}</span></td>
            <td class="num">${tx.quantity ? num(tx.quantity, 2) : '—'}</td><td class="num">${esc(fmt(tx.price))}</td>
            <td><button class="btn btn-icon btn-sm btn-ghost" data-action="delete-tx" data-id="${esc(tx.id)}" title="Delete">✕</button></td></tr>`).join('')}
        </tbody></table></div>` : emptyMini('Transactions you record will appear here.')}
      </div>
    </div>`;
}

function emptyMini(text) { return `<p class="muted small center" style="padding:26px 0">${esc(text)}</p>`; }

function discoverPage() {
  const type = state.discoverType;
  const q = state.discoverQuery.trim().toLowerCase();
  const list = INSTRUMENTS.filter(i => (type === 'All' || i.type === type) &&
    (!q || `${i.symbol} ${i.name} ${i.sector} ${i.exchange}`.toLowerCase().includes(q)));
  const remote = state.discoverRemote.filter(r => !INSTRUMENT_MAP[r.symbol]);
  const types = ['All', 'Stock', 'ETF', 'Mutual Fund', 'Crypto', 'REIT', 'Commodity'];
  return `${pageHead('Discover', 'Search global equities, funds and alternative assets.',
    `<button class="btn" data-action="nav" href="#/app/markets">Browse exchanges →</button>`)}
    <div class="card" style="margin-bottom:18px">
      <div class="search-input-wrap" style="max-width:none"><span>⌕</span><input id="discover-input" class="input" style="border:0;background:none;padding:6px" placeholder="Search by ticker, company, sector or fund name…" value="${esc(state.discoverQuery)}"/></div>
      <div class="news-filters" style="margin:16px 0 0">${types.map(t => `<button class="filter-chip ${type === t ? 'active' : ''}" data-action="discover-type" data-type="${t}">${t}</button>`).join('')}</div>
      <div class="data-note">◈ Local catalog covers ${INSTRUMENTS.length} hand-picked instruments. Type a ticker to search thousands more across global exchanges via Alpha Vantage.</div>
    </div>
    <div class="card" style="margin-bottom:18px">
      <div class="card-head"><div><h3>${q ? 'Search results' : 'Featured instruments'}</h3><div class="card-sub">${list.length} shown from the Meridian catalog</div></div></div>
      ${list.length ? `<div class="table-scroll"><table class="data"><thead><tr><th>Instrument</th><th>Type</th><th>Exchange</th><th>Price</th><th>Day</th><th>Trend</th><th></th></tr></thead><tbody>
        ${list.slice(0, 120).map(i => {
          const p = priceFor(i.symbol);
          return `<tr><td><div class="sym-cell" style="cursor:pointer" data-action="open-instrument" data-symbol="${esc(i.symbol)}">${symLogo(i.symbol)}<div><strong>${esc(i.symbol)}</strong><small>${esc(i.name)}</small></div></div></td>
            <td><span class="tag-pill">${esc(i.type)}</span></td><td class="muted">${esc(i.exchange)}</td>
            <td class="num">${esc(fmt(p.price))}</td><td class="num ${signClass(p.changePct)}">${pct(p.changePct)}</td>
            <td>${sparkline(seriesFor(i.symbol, 30).slice(-30).map(x => x.close), { width: 70, height: 22 })}</td>
            <td><div class="btn-row" style="justify-content:flex-end"><button class="btn btn-sm" data-action="quick-add" data-symbol="${esc(i.symbol)}">＋ Add</button>
              <button class="btn btn-icon btn-sm" data-action="toggle-watch" data-symbol="${esc(i.symbol)}" title="Watch">${store.data().watchlist.includes(i.symbol) ? '★' : '☆'}</button></div></td></tr>`;
        }).join('')}</tbody></table></div>` : `<div class="empty"><div class="big">⌕</div><h3>No catalog matches</h3><p>${q ? `Trying global symbol lookup for “${esc(q)}”…` : 'Pick another filter.'}</p></div>`}
    </div>
    ${remote.length ? `<div class="card"><div class="card-head"><div><h3>Global exchange matches</h3><div class="card-sub">Results from Alpha Vantage</div></div></div>
      <div class="grid grid-3">${remote.map(r => `<div class="news-card"><span class="tag-pill">${esc(r.type)}</span><h3>${esc(r.symbol)}</h3><p>${esc(r.name)}</p>
        <div class="btn-row"><button class="btn btn-sm" data-action="quick-add" data-symbol="${esc(r.symbol)}">＋ Add</button>
        <button class="btn btn-sm" data-action="open-instrument" data-symbol="${esc(r.symbol)}">Details</button></div></div>`).join('')}</div></div>` : ''}`;
}

function marketsPage() {
  const q = state.marketQuery.trim().toLowerCase();
  const regions = ['All', 'Americas', 'Europe', 'Asia Pacific', 'Africa', 'Global'];
  const list = EXCHANGES.filter(e => (state.marketRegion === 'All' || e.region === state.marketRegion) &&
    (!q || `${e.name} ${e.code} ${e.city} ${e.country}`.toLowerCase().includes(q)));
  const proxies = [['SPY','US Large Cap'], ['QQQ','US Technology'], ['VTI','US Total Market'], ['GLD','Gold'], ['TLT','Long Treasuries'], ['VXUS','International']];
  return `${pageHead('Global markets', 'The exchanges that set the world’s prices.', '')}
    <div class="grid grid-3" style="margin-bottom:18px">${proxies.map(([sym, label]) => {
      const p = priceFor(sym); const inst = instrumentFor(sym);
      return `<div class="card stat-card" style="cursor:pointer" data-action="open-instrument" data-symbol="${esc(sym)}">
        <div class="stat-label">${esc(label)} <span class="faint">· ${esc(sym)}</span></div>
        <div class="stat-value">${esc(fmt(p.price))}</div>
        <div class="stat-foot"><span class="${signClass(p.changePct)}">${pct(p.changePct)}</span> · ${esc(inst.exchange)}</div></div>`;
    }).join('')}</div>
    <div class="card">
      <div class="card-head"><div><h3>Exchanges</h3><div class="card-sub">${list.length} venues · click to explore instruments</div></div>
        <div class="search-input-wrap" style="width:240px"><span>⌕</span><input id="market-input" placeholder="Filter exchanges" value="${esc(state.marketQuery)}"/></div></div>
      <div class="news-filters">${regions.map(r => `<button class="filter-chip ${state.marketRegion === r ? 'active' : ''}" data-action="market-region" data-region="${r}">${r}</button>`).join('')}</div>
      <div class="exchange-row muted tiny"><span></span><span>EXCHANGE</span><span>SESSIONS</span><span>INSTRUMENTS</span><span></span></div>
      ${list.map(e => `<div class="exchange-row"><span class="flag">${e.flag}</span>
        <div><strong>${esc(e.name)}</strong><small>${esc(e.code)} · ${esc(e.city)}, ${esc(e.country)} · ${esc(e.classes.join(', '))}</small></div>
        <span class="muted small">${esc(e.hours)}</span><span class="count">${e.count.toLocaleString()}+</span>
        <button class="btn btn-sm" data-action="exchange" data-code="${esc(e.code)}">Explore →</button></div>`).join('')}
      <div class="data-note">◈ Exchange listings are a curated reference set; global symbol lookup covers additional venues.</div>
    </div>`;
}

function newsPage() {
  const categories = [['all','All stories'],['foryou','For you'],['macro','Macro'],['earnings','Earnings'],['funds','Funds & ETFs'],['global','Global'],['learn','Learn']];
  const items = state.newsItems;
  return `${pageHead('Market intelligence', 'Headlines, filtered to what matters to you.',
    `<button class="btn" data-action="refresh-news">↻ Refresh feed</button>`)}
    <div class="card" style="margin-bottom:18px">
      <div class="search-input-wrap" style="max-width:none"><span>⌕</span><input id="news-input" placeholder="Search headlines and topics…" value="${esc(state.newsQuery)}"/></div>
      <div class="news-filters" style="margin:16px 0 0">${categories.map(([k, l]) => `<button class="filter-chip ${state.newsCategory === k ? 'active' : ''}" data-action="news-category" data-category="${k}">${l}</button>`).join('')}</div>
    </div>
    ${items.length ? `<div class="grid grid-3">${items.map((n, i) => `<article class="news-card" style="cursor:pointer" data-action="article" data-index="${i}">
      <div class="kicker"><span>${esc(n.source || 'Markets')}</span>${n.demo ? '<span class="tag-pill">sample</span>' : '<span class="badge live">live</span>'}</div>
      <h3>${esc(n.title)}</h3>${n.summary ? `<p>${esc(n.summary)}</p>` : ''}
      <div class="meta">${esc(dateLabel(n.published, { relative: true }))} · ${esc((state.newsCategory === 'all' ? 'Global markets' : state.newsCategory).toUpperCase())}</div>
    </article>`).join('')}</div>` : `<div class="card"><div class="empty"><div class="big">▧</div><h3>${state.newsLoading ? 'Gathering headlines…' : 'No stories yet'}</h3><p>Fetching a fresh briefing for your selected topic.</p></div></div>`}
    <div class="data-note">◈ Live headlines from Google News. If the feed is unavailable, clearly-labelled sample briefings are shown instead.</div>`;
}

function watchlistPage() {
  const watch = store.data().watchlist;
  return `${pageHead('Watchlist', 'The instruments on your radar.', `<button class="btn btn-primary" data-action="add-watch">＋ Add to watchlist</button>`)}
    <div class="card">
      <div class="card-head"><h3>${watch.length} instruments</h3><div class="card-sub">Prices refresh when you open the app</div></div>
      ${watch.length ? `<div class="table-scroll"><table class="data"><thead><tr><th>Instrument</th><th>Type</th><th>Price</th><th>Day</th><th>Trend</th><th></th></tr></thead><tbody>
        ${watch.map(sym => {
          const q = priceFor(sym); const i = instrumentFor(sym);
          return `<tr><td><div class="sym-cell" style="cursor:pointer" data-action="open-instrument" data-symbol="${esc(sym)}">${symLogo(sym)}<div><strong>${esc(sym)}</strong><small>${esc(i.name)}</small></div></div></td>
            <td><span class="tag-pill">${esc(i.type)}</span></td><td class="num">${esc(fmt(q.price))}</td>
            <td class="num ${signClass(q.changePct)}">${pct(q.changePct)}</td>
            <td>${sparkline(seriesFor(sym, 30).slice(-30).map(p => p.close), { width: 74, height: 22 })}</td>
            <td><div class="btn-row" style="justify-content:flex-end"><button class="btn btn-sm" data-action="quick-add" data-symbol="${esc(sym)}">＋ Add</button>
              <button class="btn btn-icon btn-sm btn-danger" data-action="remove-watch" data-symbol="${esc(sym)}">✕</button></div></td></tr>`;
        }).join('')}</tbody></table></div>` : `<div class="empty"><div class="big">☆</div><h3>Your watchlist is empty</h3><p>Add symbols from Discover or an instrument page to follow them here.</p><button class="btn btn-primary" data-action="add-watch">Add an instrument</button></div>`}
    </div>`;
}

function goalsPage() {
  const goals = store.data().goals;
  const total = metrics().total;
  return `${pageHead('Goals', 'Give your portfolio a purpose.', `<button class="btn btn-primary" data-action="add-goal">＋ New goal</button>`)}
    <div class="grid grid-3">${goals.length ? goals.map(g => {
      const progress = clamp(total / (Number(g.target) || 1) * 100, 0, 100);
      const years = g.deadline ? Math.max(0, Math.ceil((new Date(g.deadline) - Date.now()) / (365.25 * 86400000))) : null;
      return `<div class="card goal-card"><div class="goal-top"><span class="goal-icon" style="background:${g.color}22;color:${g.color}">${esc(g.icon || '◈')}</span>
        <div style="flex:1"><h3>${esc(g.name)}</h3><span class="tiny faint">${years != null ? `${years} years to target` : 'No date set'}</span></div>
        <button class="btn btn-icon btn-sm btn-ghost" data-action="delete-goal" data-id="${esc(g.id)}">✕</button></div>
        <div><div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:8px"><span class="muted">${esc(fmt(total))} of ${esc(fmt(g.target))}</span><b>${progress.toFixed(1)}%</b></div>
        <div class="progress"><span style="width:${progress}%;background:${g.color}"></span></div></div>
        <div class="tiny faint">Measured against your total portfolio value of ${esc(fmt(total))}.</div></div>`;
    }).join('') : `<div class="empty" style="grid-column:1/-1"><div class="big">◎</div><h3>No goals yet</h3><p>Set a target and track how your portfolio is moving toward it.</p><button class="btn btn-primary" data-action="add-goal">Create a goal</button></div>`}</div>`;
}

/* ---------------------------- Meridian Connector ---------------------------- */

function expiryLabel(value) {
  if (!value) return 'Request a code below';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Expires soon';
  return `Expires at ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

function setConnectorMessage(text, kind = 'error') {
  state.connector.message = text ? String(text) : '';
  state.connector.messageKind = kind;
  const el = $('#connector-message');
  if (el) {
    el.textContent = state.connector.message;
    el.className = `connector-message ${kind}`;
    el.hidden = !state.connector.message;
  }
}

function paintConnectorStatus() {
  const s = connector.status();
  const badge = $('#connector-badge');
  if (badge) {
    badge.className = `badge connector-badge ${s.connected ? 'live' : 'neutral'}`;
    badge.innerHTML = `<span class="conn-dot ${s.connected ? 'connected' : 'disconnected'}"></span>${s.connected ? 'Connected' : 'Not connected'}`;
  }
  const last = $('#connector-last-sync');
  if (last) {
    const when = state.connector.lastSyncAt || s.lastSyncAt;
    last.textContent = when ? dateLabel(when, { relative: true }) : 'Not yet synced';
  }
  const code = $('#pair-code-value');
  if (code && state.connector.code) code.textContent = String(state.connector.code).split('').join(' ');
  const exp = $('#pair-expires');
  if (exp) exp.textContent = expiryLabel(state.connector.expiresAt);
  const copy = $('[data-action="connector-copy-code"]');
  if (copy) copy.disabled = !state.connector.code;
}

function connectorCardMarkup() {
  const s = connector.status();
  const connected = !!s.connected;
  const user = state.connector.user || s.user;
  const code = String(state.connector.code || '');
  const last = state.connector.lastSyncAt || s.lastSyncAt;
  return `<div class="card connector-card" id="connector-card">
    <div class="card-head">
      <div><h3>Meridian Connector</h3><div class="card-sub">Live cloud sync across Atlas Financial apps</div></div>
      <span class="badge ${connected ? 'live' : 'neutral'} connector-badge" id="connector-badge">
        <span class="conn-dot ${connected ? 'connected' : 'disconnected'}"></span>${connected ? 'Connected' : 'Not connected'}</span>
    </div>
    <p class="muted small">${connected
      ? 'Your Meridian data stays in sync with the cloud. Share the pairing code below with Airo Finance to link the two apps.'
      : 'Link your Meridian account with the new Meridian Connector to sync your portfolio with Airo Finance in real time.'}</p>

    <div class="field" style="margin-top:16px"><label for="sync-endpoint">Sync server URL</label>
      <input class="input" id="sync-endpoint" type="url" spellcheck="false" autocomplete="off" value="${esc(s.endpoint)}" placeholder="https://atlas-sync.greenhenry441.workers.dev"/>
      <span class="faint tiny">The sync server must be running for the first connection.</span></div>

    <div class="connector-message ${esc(state.connector.messageKind || 'error')}" id="connector-message" role="alert" ${state.connector.message ? '' : 'hidden'}>${esc(state.connector.message)}</div>

    ${connected ? `
      <div class="connector-connected">
        <div class="connector-status-row">
          <div><span class="connector-label">Cloud account</span><strong class="truncate">${esc(user?.email || 'Connected account')}</strong></div>
          <div><span class="connector-label">Last sync</span><strong id="connector-last-sync">${last ? esc(dateLabel(last, { relative: true })) : 'Not yet synced'}</strong></div>
        </div>
        <div class="pair-box">
          <div class="pair-head"><span class="connector-label">Your pairing code</span><span class="tiny faint" id="pair-expires">${esc(expiryLabel(state.connector.expiresAt))}</span></div>
          <div class="pair-code-row">
            <div class="pair-code" id="pair-code-value" aria-label="Pairing code">${code ? esc(code.split('').join(' ')) : '— — — — — —'}</div>
            <button class="btn btn-sm" data-action="connector-copy-code" ${code ? '' : 'disabled'}>⧉ Copy</button>
          </div>
          <p class="tiny faint" style="margin-top:10px">Enter this code in <b>Airo Finance → Meridian Connector</b> to link accounts. It expires in 10 minutes and can only be used once.</p>
        </div>
        <div class="btn-row connector-actions">
          <button class="btn btn-sm" data-action="connector-refresh-code">↻ Refresh code</button>
          <button class="btn btn-mint btn-sm" data-action="connector-sync-now">⇅ Sync now</button>
          <button class="btn btn-danger btn-sm" data-action="connector-disconnect">Disconnect</button>
        </div>
      </div>`
      : `
      <form id="connector-form" class="connector-form">
        <div class="form-grid">
          <div class="field"><label for="cloud-email">Cloud email</label>
            <input class="input" id="cloud-email" name="email" type="email" autocomplete="email" placeholder="you@example.com" required/></div>
          <div class="field"><label for="cloud-password">Cloud password</label>
            <input class="input" id="cloud-password" name="password" type="password" autocomplete="current-password" placeholder="At least 8 characters" required/></div>
        </div>
        <button class="btn btn-primary" id="connector-connect" type="submit">Connect cloud account →</button>
      </form>
      <div class="notice" style="margin-top:14px">We sign in with these details first. If no cloud account exists yet, one is created using your Meridian name and email. Your password is sent only to the sync server and is never stored in this browser.</div>`}
  </div>`;
}

async function copyPairingCode() {
  const code = String(state.connector.code || '');
  if (!code) { toast('Request a pairing code first.', 'error'); return; }
  let done = false;
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(code); done = true; }
  } catch { /* fall back to the selection method below */ }
  if (!done) {
    try {
      const field = document.createElement('textarea');
      field.value = code;
      field.setAttribute('readonly', '');
      field.style.position = 'fixed';
      field.style.opacity = '0';
      document.body.appendChild(field);
      field.select();
      done = document.execCommand('copy');
      field.remove();
    } catch { done = false; }
  }
  toast(done ? 'Pairing code copied.' : 'Copy failed — select the code and copy it manually.', done ? 'success' : 'error');
}

async function refreshPairCode(announce = true) {
  try {
    const result = await connector.requestCode();
    state.connector.code = String(result?.code || '').replace(/\D/g, '').slice(0, 6);
    state.connector.expiresAt = result?.expiresAt || null;
    if (!state.connector.code) throw new Error('The sync server did not return a pairing code.');
    setConnectorMessage('', 'error');
    paintConnectorStatus();
    if (announce) toast('New pairing code ready.');
    return true;
  } catch (err) {
    const message = err?.message || 'Could not request a pairing code.';
    setConnectorMessage(message);
    toast(message, 'error');
    return false;
  }
}

async function pushSnapshot(announce = false) {
  if (!connector.status().connected) return false;
  try {
    const result = await connector.putSnapshot('meridian', store.data(), connector.clientId());
    state.connector.lastSyncAt = result?.updatedAt || Date.now();
    if (result?.updatedAt) state.connector.lastRemoteUpdatedAt = result.updatedAt;
    state.connector.pushFailed = false;
    setConnectorMessage('', 'error');
    paintConnectorStatus();
    if (announce) toast('Meridian data synced to the cloud.');
    return true;
  } catch (err) {
    const message = err?.message || 'Cloud sync failed.';
    setConnectorMessage(message);
    if (!state.connector.pushFailed) toast(message, 'error');
    state.connector.pushFailed = true;
    return false;
  }
}

function startCloudSubscription() {
  if (cloudUnsubscribe || !connector.status().connected) return;
  cloudUnsubscribe = connector.subscribe(async event => {
    if (!event || typeof event !== 'object') return;
    if (event.type === 'error') { setConnectorMessage(event.message || 'Live sync is unavailable.'); return; }
    if (event.app && event.app !== 'meridian') return;
    if (event.clientId && event.clientId === connector.clientId()) return;
    if (event.updatedAt && state.connector.lastRemoteUpdatedAt === event.updatedAt) return;
    if (!store.currentUser()) return;
    applyingRemote = true;
    try {
      const snapshot = await connector.getSnapshot('meridian');
      if (snapshot?.data && Array.isArray(snapshot.data.holdings)) {
        const result = store.importData({ data: snapshot.data });
        if (result.ok) {
          if (snapshot.updatedAt || event.updatedAt) state.connector.lastRemoteUpdatedAt = snapshot.updatedAt || event.updatedAt;
          state.connector.lastSyncAt = snapshot.updatedAt || event.updatedAt || Date.now();
          state.connector.pushFailed = false;
          setConnectorMessage('', 'error');
          render({ preserve: true });
          toast('Latest cloud changes applied.');
        }
      }
    } catch (err) {
      setConnectorMessage(err?.message || 'Could not load the cloud snapshot.');
    } finally { applyingRemote = false; }
  });
}

async function connectCloud(email, password) {
  if (state.connector.busy) return;
  const normalized = String(email || '').trim().toLowerCase();
  const secret = String(password || '');
  if (!/^\S+@\S+\.\S+$/.test(normalized)) { setConnectorMessage('Enter a valid cloud email address.'); toast('Enter a valid cloud email address.', 'error'); return; }
  if (secret.length < 8) { setConnectorMessage('Cloud passwords must be at least 8 characters.'); toast('Cloud passwords must be at least 8 characters.', 'error'); return; }

  state.connector.busy = true;
  setConnectorMessage('Checking the sync server…', 'info');
  if (!await connector.available()) {
    state.connector.busy = false;
    const message = `Sync server unreachable at ${connector.endpoint()}. Start it and try again.`;
    setConnectorMessage(message); toast(message, 'error'); return;
  }

  let result = null;
  try {
    result = await connector.login({ email: normalized, password: secret });
  } catch (loginError) {
    try {
      result = await connector.signup({
        email: normalized,
        name: store.currentUser()?.name || normalized.split('@')[0],
        password: secret,
      });
    } catch (signupError) {
      state.connector.busy = false;
      const message = signupError?.message || loginError?.message || 'Could not connect to the cloud account.';
      setConnectorMessage(message); toast(message, 'error'); return;
    }
  }

  state.connector.connected = true;
  state.connector.user = result?.user || connector.status().user;
  state.connector.code = '';
  state.connector.expiresAt = null;
  state.connector.lastSyncAt = null;
  state.connector.lastRemoteUpdatedAt = '';
  state.connector.pushFailed = false;
  startCloudSubscription();
  await refreshPairCode(false);
  await pushSnapshot(false);
  state.connector.busy = false;
  render({ preserve: true });
  toast('Cloud account connected. Live sync is on.');
}

async function syncNow() {
  if (state.connector.busy) return;
  state.connector.busy = true;
  const pushed = await pushSnapshot(false);
  if (pushed) {
    try {
      const snapshot = await connector.getSnapshot('meridian');
      if (snapshot?.updatedAt) state.connector.lastSyncAt = snapshot.updatedAt;
      if (snapshot?.updatedAt !== state.connector.lastRemoteUpdatedAt && snapshot?.data && Array.isArray(snapshot.data.holdings) && store.currentUser()) {
        state.connector.lastRemoteUpdatedAt = snapshot.updatedAt || '';
        applyingRemote = true;
        try { store.importData({ data: snapshot.data }); } finally { applyingRemote = false; }
        render({ preserve: true });
      }
      paintConnectorStatus();
      toast('Meridian is up to date with the cloud.');
    } catch (err) {
      const message = err?.message || 'Could not load the cloud snapshot.';
      setConnectorMessage(message); toast(message, 'error');
    }
  }
  state.connector.busy = false;
}

function disconnectCloud() {
  if (cloudUnsubscribe) { cloudUnsubscribe(); cloudUnsubscribe = null; }
  connector.signOut();
  Object.assign(state.connector, {
    connected: false, code: '', expiresAt: null, user: null, lastSyncAt: null,
    lastRemoteUpdatedAt: '', pushFailed: false, busy: false,
  });
  setConnectorMessage('', 'error');
  toast('Cloud account disconnected. Local data is unchanged.');
  render({ preserve: true });
}

function settingsPage() {
  const user = store.currentUser();
  const prefs = store.getPrefs();
  const status = api.apiStatus();
  return `${pageHead('Settings', 'Your account, preferences and data.', '')}
    <div class="grid grid-2">
      <div class="stack">
        <div class="card"><div class="card-head"><h3>Profile</h3><span class="badge neutral">Local account</span></div>
          <div style="display:flex;align-items:center;gap:14px;margin-bottom:20px"><span class="avatar" style="width:46px;height:46px;font-size:15px">${esc(initials(user?.name || 'Investor'))}</span>
            <div><strong>${esc(user?.name || '')}</strong><div class="muted small">${esc(user?.email || '')}</div></div></div>
          <div class="notice">This account and its portfolio data are stored only in this browser. Clearing browser storage removes them — export regularly.</div>
        </div>
        ${connectorCardMarkup()}
        <div class="card"><div class="card-head"><h3>Preferences</h3></div>
          <div class="field"><label for="theme-select">Appearance</label><select class="input" id="theme-select"><option value="dark" ${prefs.theme !== 'light' ? 'selected' : ''}>Midnight (dark)</option><option value="light" ${prefs.theme === 'light' ? 'selected' : ''}>Daylight (light)</option></select></div>
          <div class="field"><label for="currency-select">Display currency</label><select class="input" id="currency-select">${CURRENCIES.map(c => `<option ${prefs.currency === c ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
          <form id="api-key-form"><div class="field"><label for="api-key">Alpha Vantage API key</label>
            <input class="input" id="api-key" name="apiKey" value="${esc(prefs.apiKey || '')}" placeholder="Paste your Alpha Vantage key"/>
            <span class="faint tiny">No key is bundled. Yours is stored only in this browser; without one, Meridian uses cached/sample data.</span></div>
            <button class="btn btn-sm" type="submit">Save key</button></form>
        </div>
        <div class="card"><div class="card-head"><h3>Meridian AI</h3><span class="badge live">On-device</span></div>
          <p class="muted small">Private AI with no API key and no provider quota. Models run on your device through WebGPU; portfolio data is never uploaded.</p>
          <div class="field" style="margin-top:16px"><label for="settings-ai-model">Local model</label>
            <select class="input" id="settings-ai-model">${AI_MODELS.map(m => `<option value="${esc(m.id)}" ${m.id === (prefs.aiModel || DEFAULT_AI_MODEL) ? 'selected' : ''}>${esc(m.label)} — ${esc(m.note)}</option>`).join('')}</select></div>
          <div class="btn-row"><button class="btn btn-sm" data-action="nav" href="${ROUTES.ai}">Open Meridian AI →</button></div>
        </div>
      </div>
      <div class="stack">
        <div class="card"><div class="card-head"><h3>Data</h3><div class="card-sub">Your information stays portable</div></div>
          <div class="btn-row"><button class="btn" data-action="export">↧ Export portfolio JSON</button>
            <button class="btn" data-action="import">↥ Import portfolio JSON</button></div>
          ${user?.email === 'demo@meridian.app' ? `<button class="btn btn-sm" style="margin-top:14px" data-action="reset-demo">Reset demo data</button>` : ''}
          <div class="data-note">◈ Live API requests used today: ${status.used} / ${status.limit}. Quotes and history are cached locally.</div>
        </div>
        <div class="card"><div class="card-head"><h3>Security</h3></div>
          <div class="stack" style="gap:10px"><div class="insight"><span class="ic">◇</span><div><strong>Salted PBKDF2 password</strong><p>Your password is never stored in plain text.</p></div></div>
          <div class="insight"><span class="ic">⌂</span><div><strong>Local-first architecture</strong><p>No server receives your holdings, watchlist or goals.</p></div></div></div>
          <div class="btn-row" style="margin-top:18px"><button class="btn" data-action="logout">Sign out</button>
            <button class="btn btn-danger" data-action="delete-account">Delete account</button></div>
        </div>
      </div>
    </div>`;
}

function instrumentPage(symbol) {
  const sym = String(symbol || '').toUpperCase();
  const inst = instrumentFor(sym);
  const q = priceFor(sym);
  const overview = state.overviews[sym] || {};
  const chart = lineChart(sliceRange(seriesFor(sym).map(p => ({ date: p.date, value: p.close })), state.range), {
    height: 300, currency: inst.currency || currency(),
  });
  const held = store.data().holdings.find(h => h.symbol === sym);
  const watched = store.data().watchlist.includes(sym);
  const keyvals = [
    ['Previous close', q.previousClose ? fmt(q.previousClose) : '—'],
    ['Day range', q.low && q.high ? `${fmt(q.low)} – ${fmt(q.high)}` : '—'],
    ['52-week range', overview.low52 && overview.high52 ? `${fmt(overview.low52)} – ${fmt(overview.high52)}` : '—'],
    ['Market cap', overview.marketCap ? compact(overview.marketCap) : '—'],
    ['P/E ratio', overview.peRatio || '—'],
    ['Dividend yield', overview.dividendYield ? `${(overview.dividendYield * 100).toFixed(2)}%` : '—'],
    ['Sector', overview.sector || inst.sector],
    ['Exchange', inst.exchange],
  ];
  return `${pageHead(`${esc(sym)} <span class="badge neutral">${esc(inst.type)}</span>`, esc(inst.name),
    `<button class="btn" data-action="toggle-watch" data-symbol="${esc(sym)}">${watched ? '★ Watching' : '☆ Watch'}</button>
     <button class="btn" data-action="ai-prompt" data-prompt="Explain ${esc(sym)} in plain English and how it fits into a diversified portfolio.">✦ Ask AI</button>
     <button class="btn btn-primary" data-action="quick-add" data-symbol="${esc(sym)}">＋ ${held ? 'Add more' : 'Add to portfolio'}</button>`,
    `<a href="#/app/discover">Discover</a> / ${esc(sym)}`)}
    <div class="card" style="margin-bottom:18px">
      <div class="instrument-hero">${symLogo(sym)}<div><div class="price-hero num">${esc(fmt(q.price))}</div>
        <div class="hero-meta"><span class="badge ${signClass(q.changePct)}">${q.change >= 0 ? '↗' : '↘'} ${esc(fmt(Math.abs(q.change || q.price * q.changePct / 100)))} (${pct(q.changePct)})</span>
        <span class="badge ${q.live ? 'live' : 'neutral'}">${q.live ? 'Live quote' : 'Demo price'}</span>
        <span class="faint tiny">${q.tradingDay ? `As of ${esc(q.tradingDay)}` : 'Cached / simulated data'}</span></div></div></div>
    </div>
    <div class="grid grid-main" style="margin-bottom:18px">
      <div class="card"><div class="card-head"><div><h3>Price history</h3><div class="card-sub">Daily closes · ${esc(inst.currency || currency())}</div></div>
        <div class="segmented">${['1M','3M','6M','1Y'].map(r => `<button class="${state.range === r ? 'active' : ''}" data-action="range" data-range="${r}">${r}</button>`).join('')}</div></div>${chart}</div>
      <div class="card"><div class="card-head"><h3>Key facts</h3></div><div class="keyvals">${keyvals.map(([k,v]) => `<div class="keyval"><span>${esc(k)}</span><strong>${esc(v)}</strong></div>`).join('')}</div></div>
    </div>
    <div class="card"><div class="card-head"><h3>About ${esc(sym)}</h3><span class="tag-pill">${esc(inst.exchange)}</span></div>
      <p class="muted small">${esc(overview.description || `${inst.name} trades on ${inst.exchange} and is classified under ${inst.sector}. Add it to your portfolio or watchlist to follow its price alongside the rest of your investments.`)}</p>
      <div class="data-note">◈ Fundamentals and history supplied by Alpha Vantage when available; offline values are clearly labelled.</div>
    </div>`;
}

/* ---------------------------- Meridian AI ---------------------------- */

function formatAiText(text = '') {
  return esc(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/^###\s+(.+)$/gm, '<h4>$1</h4>')
    .replace(/^##\s+(.+)$/gm, '<h3>$1</h3>')
    .replace(/^[-•]\s+(.+)$/gm, '<li>$1</li>')
    .replace(/\n{2,}/g, '<br><br>')
    .replace(/\n/g, '<br>');
}

function aiMessageMarkup(message) {
  const isUser = message.role === 'user';
  const avatar = isUser ? esc(initials(store.currentUser()?.name || 'Investor')) : '✦';
  const body = message.content
    ? formatAiText(message.content)
    : message.pending ? '<span class="ai-typing"><i></i><i></i><i></i></span>' : '';
  return `<div class="ai-message ${isUser ? 'user' : 'assistant'}" id="ai-message-${esc(message.id)}">
    <span class="ai-avatar">${avatar}</span><div class="ai-message-body">${body}</div></div>`;
}

function paintAiStatus() {
  const supported = ai.supportsAI();
  const modelId = store.getPrefs().aiModel || DEFAULT_AI_MODEL;
  const loaded = ai.isLoaded() && ai.activeModel() === modelId;
  const status = $('#ai-status');
  if (status) {
    status.innerHTML = !supported
      ? '<span class="status-dot closed"></span> WebGPU unavailable'
      : loaded ? '<span class="status-dot"></span> Model loaded locally'
      : state.aiProgress ? '<span class="status-dot closed"></span> Loading local model'
      : '<span class="status-dot closed"></span> Ready to load';
  }
  const progressWrap = $('#ai-progress');
  if (progressWrap) progressWrap.hidden = !state.aiProgress;
  if (state.aiProgress) {
    const bar = $('#ai-progress-bar');
    const text = $('#ai-progress-text');
    if (bar) bar.style.width = `${clamp(state.aiProgress.percent || 0, 0, 100)}%`;
    if (text) text.textContent = `${state.aiProgress.percent || 0}% · ${state.aiProgress.text}`;
  }
  const send = $('#ai-send');
  if (send) send.disabled = state.aiBusy || !supported || !loaded;
  const stop = $('#ai-stop');
  if (stop) stop.hidden = !state.aiBusy;
  const load = $('#ai-load');
  if (load) load.disabled = loaded || !supported || !!state.aiProgress;
}

function scrollAiToBottom() {
  const box = $('#ai-messages');
  if (box) box.scrollTop = box.scrollHeight;
}

function starterPrompts() {
  const d = store.data();
  const top = [...metrics().rows].sort((a, b) => b.weight - a.weight)[0];
  return [
    'Summarize my portfolio in plain English.',
    "What changed in my portfolio today?",
    top ? `Explain ${top.symbol} in plain English and how it affects my portfolio.` : 'Explain diversification in plain English.',
    'Summarize the market news connected to my holdings.',
    d.watchlist.length ? 'What should I understand about the instruments on my watchlist?' : 'How do I build a useful watchlist?',
  ];
}

function buildAIContext() {
  const d = store.data();
  const m = metrics();
  const blocks = [`Display currency: ${currency()}`];

  if (state.aiContext.portfolio) {
    const top = [...m.rows].sort((a, b) => b.value - a.value).slice(0, 10);
    blocks.push(`PORTFOLIO\nTotal value: ${fmt(m.total)}\nDay change: ${fmt(m.day)} (${pct(m.dayPct)})\nTotal return: ${fmt(m.gain)} (${pct(m.gainPct)})\nPositions: ${m.rows.length}\nHoldings:\n${top.map(r => `- ${r.symbol} (${r.name}), ${r.type}, ${r.weight.toFixed(1)}% of portfolio, value ${fmt(r.value)}, day ${pct(r.changePct)}, total return ${pct(r.gainPct)}${r.type === 'Stock' ? `, sector ${r.sector}` : ''}`).join('\n') || '- No holdings recorded'}`);
  }
  if (state.aiContext.watchlist) {
    blocks.push(`WATCHLIST\n${d.watchlist.slice(0, 12).map(sym => {
      const q = priceFor(sym);
      const inst = instrumentFor(sym);
      return `- ${sym} (${inst.name}), ${inst.type}, price ${fmt(q.price)}, day ${pct(q.changePct)}${q.live ? '' : ' [cached/demo price]'}`;
    }).join('\n') || '- Watchlist is empty'}`);
  }
  if (state.aiContext.news) {
    blocks.push(`RECENT HEADLINES\n${state.newsItems.slice(0, 6).map(n => `- ${n.title} (${n.source || 'Markets'}${n.demo ? ', sample' : ''})`).join('\n') || '- No headlines loaded in this session'}`);
  }
  if (d.goals.length) {
    blocks.push(`GOALS\n${d.goals.slice(0, 6).map(g => `- ${g.name}: target ${fmt(g.target)}, measured against total portfolio value`).join('\n')}`);
  }
  return blocks.join('\n\n');
}

function aiPage() {
  const supported = ai.supportsAI();
  const prefs = store.getPrefs();
  const modelId = prefs.aiModel || DEFAULT_AI_MODEL;
  const model = AI_MODELS.find(m => m.id === modelId) || AI_MODELS[1];
  const loaded = ai.isLoaded() && ai.activeModel() === modelId;
  const prompts = starterPrompts();

  return `${pageHead('Meridian AI', 'Private, on-device intelligence for your portfolio.',
    `<button class="btn" data-action="ai-clear">Clear conversation</button>`)}
    ${!supported ? `<div class="notice warn" style="margin-bottom:18px"><strong>WebGPU is not available in this browser.</strong> Meridian AI needs a recent Chrome or Edge browser with hardware acceleration enabled. The rest of Meridian continues to work normally.</div>` : ''}
    ${state.aiError ? `<div class="notice warn" style="margin-bottom:18px">${esc(state.aiError)}</div>` : ''}

    <div class="grid grid-main ai-layout">
      <div class="card ai-chat-card">
        <div class="ai-chat-head">
          <div><h3>Ask Meridian AI</h3><div class="card-sub">Runs in this browser · nothing sent to an AI provider</div></div>
          <div class="market-status" id="ai-status"><span class="status-dot closed"></span> ${loaded ? 'Model loaded locally' : 'Ready to load'}</div>
        </div>
        <div class="ai-context-bar">
          <span class="tiny faint">CONTEXT</span>
          ${[['portfolio', 'Portfolio'], ['watchlist', 'Watchlist'], ['news', 'Headlines']].map(([key, label]) =>
            `<button class="filter-chip ${state.aiContext[key] ? 'active' : ''}" data-action="ai-toggle-context" data-key="${key}">${state.aiContext[key] ? '✓ ' : ''}${label}</button>`).join('')}
        </div>
        <div class="ai-messages" id="ai-messages">${state.aiMessages.map(aiMessageMarkup).join('')}</div>
        <form id="ai-chat-form" class="ai-compose">
          <textarea class="input" id="ai-input" rows="2" placeholder="${supported ? (loaded ? 'Ask about your portfolio, a holding or the latest headlines…' : 'Load a model to start chatting…') : 'WebGPU required for Meridian AI'}" ${supported && loaded ? '' : 'disabled'}>${esc(state.aiPrefill)}</textarea>
          <div class="ai-compose-actions">
            <span class="tiny faint">Educational only · not financial advice</span>
            <button type="button" class="btn btn-sm btn-danger" id="ai-stop" data-action="ai-stop" hidden>Stop</button>
            <button type="submit" class="btn btn-primary btn-sm" id="ai-send" ${supported && loaded && !state.aiBusy ? '' : 'disabled'}>Send ↗</button>
          </div>
        </form>
      </div>

      <div class="stack">
        <div class="card"><div class="card-head"><h3>Local model</h3><span class="badge neutral">No API key</span></div>
          <div class="ai-model-list">${AI_MODELS.map(m => `<button class="ai-model-option ${m.id === modelId ? 'active' : ''}" data-action="ai-model" data-model="${esc(m.id)}">
            <span class="radio-dot"></span><span><strong>${esc(m.label)}</strong><small>${esc(m.note)}</small></span></button>`).join('')}</div>
          <div class="ai-progress" id="ai-progress" ${state.aiProgress ? '' : 'hidden'}><span id="ai-progress-text">0% · Preparing…</span><div class="ai-progress-track"><span id="ai-progress-bar" style="width:0%"></span></div></div>
          <button class="btn btn-primary btn-sm" id="ai-load" data-action="ai-load" ${supported && !loaded && !state.aiProgress ? '' : 'disabled'}>${loaded ? 'Model ready' : 'Load model'}</button>
          <div class="data-note">◈ ${esc(model.label)} · first load downloads model files; later chats are instant.</div>
        </div>
        <div class="card"><div class="card-head"><h3>Try asking</h3></div>
          <div class="ai-prompts">${prompts.map(p => `<button class="ai-prompt" data-action="ai-prompt" data-prompt="${esc(p)}">${esc(p)} <span>↗</span></button>`).join('')}</div>
        </div>
        <div class="card"><div class="card-head"><h3>Why local?</h3><span class="badge live">Private</span></div>
          <div class="stack" style="gap:10px">
            <div class="insight"><span class="ic">⌂</span><div><strong>No data upload</strong><p>Your holdings, watchlist and goals stay in this browser.</p></div></div>
            <div class="insight"><span class="ic">∞</span><div><strong>No usage cap</strong><p>No provider quota, API key or per-message bill.</p></div></div>
            <div class="insight"><span class="ic">◇</span><div><strong>Educational only</strong><p>Meridian AI explains information; it does not give personal advice.</p></div></div>
          </div>
        </div>
      </div>
    </div>`;
}

async function loadAIModel() {
  const modelId = store.getPrefs().aiModel || DEFAULT_AI_MODEL;
  if (!ai.supportsAI()) { toast('WebGPU is not available in this browser.', 'error'); return; }
  if (ai.isLoaded() && ai.activeModel() === modelId) { toast('Model is already loaded.'); return; }
  state.aiError = '';
  state.aiProgress = { percent: 0, text: 'Preparing the local model…' };
  toast('Loading the local AI model. This can take a few minutes the first time.');
  render({ preserve: true });
  try {
    await ai.load(modelId);
    state.aiProgress = null;
    toast('Meridian AI is ready.');
  } catch (err) {
    state.aiProgress = null;
    state.aiError = err?.message || ai.error() || 'The local model could not be loaded.';
    toast('Meridian AI could not load.', 'error');
  }
  render({ preserve: true });
  scrollAiToBottom();
}

function appendAiToken(id, token) {
  const message = state.aiMessages.find(m => m.id === id);
  if (!message) return;
  message.content += token;
  const body = $(`#ai-message-${id} .ai-message-body`);
  if (body) body.innerHTML = formatAiText(message.content);
  scrollAiToBottom();
}

async function askAI(question) {
  const prompt = String(question || '').trim();
  if (!prompt || state.aiBusy) return;
  if (!ai.supportsAI()) { toast('Meridian AI needs WebGPU.', 'error'); return; }
  const modelId = store.getPrefs().aiModel || DEFAULT_AI_MODEL;
  const responseId = uid('msg');
  state.aiPrefill = '';
  state.aiError = '';
  state.aiMessages.push({ id: uid('msg'), role: 'user', content: prompt });
  state.aiMessages.push({ id: responseId, role: 'assistant', content: '', pending: true });
  state.aiBusy = true;
  state.aiProgress = ai.isLoaded() ? null : { percent: 0, text: 'Loading the local model…' };
  render({ preserve: true });
  scrollAiToBottom();

  try {
    await ai.load(modelId);
    state.aiProgress = null;
    paintAiStatus();
    const context = buildAIContext();
    const messages = [
      { role: 'system', content: `${AI_SYSTEM_PROMPT}\n\nAPP CONTEXT\n${context}` },
      ...state.aiMessages.filter(m => !m.pending && m.content).slice(-12).map(m => ({ role: m.role, content: m.content })),
    ];
    const answer = await ai.chat({ messages, onToken: token => appendAiToken(responseId, token) });
    const response = state.aiMessages.find(m => m.id === responseId);
    if (response) {
      response.pending = false;
      if (!response.content) response.content = answer || 'I could not generate a response. Please try again.';
    }
  } catch (err) {
    const response = state.aiMessages.find(m => m.id === responseId);
    if (response) {
      response.pending = false;
      response.content = `I couldn't start the local model. ${err?.message || 'Please try again.'}`;
    }
    state.aiError = err?.message || ai.error() || 'Meridian AI could not complete that request.';
  } finally {
    state.aiBusy = false;
    state.aiProgress = null;
    render({ preserve: true });
    scrollAiToBottom();
  }
}

/* ---------------------------- onboarding ---------------------------- */

function onboardingModal() {
  const themes = [
    ['dark', '◐', 'Midnight', 'The focused dark workspace you know.'],
    ['light', '☀', 'Daylight', 'A bright, clean workspace for daytime use.'],
  ];
  const selected = new Set(state.onboarding.watchlist);
  openModal(`<div class="modal-head onboarding-head">
      <div><span class="eyebrow">WELCOME TO MERIDIAN</span><h2>Make it yours</h2><p>Choose a look and a few instruments to follow. You can change everything later.</p></div>
    </div>
    <form id="onboarding-form">
      <div class="onboard-section">
        <div class="onboard-label"><b>1</b><span>Choose your theme</span></div>
        <div class="theme-choices">${themes.map(([key, icon, title, note]) => `<button type="button" class="theme-choice ${state.onboarding.theme === key ? 'active' : ''}" data-action="onboarding-theme" data-theme="${key}">
          <span class="theme-preview ${key}"><i></i><i></i><i></i></span><span class="theme-icon">${icon}</span><strong>${title}</strong><small>${note}</small></button>`).join('')}</div>
      </div>
      <div class="onboard-section">
        <div class="onboard-label"><b>2</b><span>Build a starter watchlist</span></div>
        <p class="muted small" style="margin-bottom:14px">Pick any symbols you already follow. Add a custom ticker too — it does not need to be in our catalog.</p>
        <div class="watch-chip-grid">${SUGGESTED_WATCHLIST.map(sym => `<button type="button" class="watch-chip ${selected.has(sym) ? 'active' : ''}" data-action="onboarding-toggle-symbol" data-symbol="${sym}">${selected.has(sym) ? '✓ ' : '＋ '}${sym}</button>`).join('')}</div>
        <div class="onboard-custom"><input class="input" id="onboarding-symbol" placeholder="Custom ticker, e.g. BRK.B" maxlength="20"/>
          <button type="button" class="btn btn-sm" data-action="onboarding-add-symbol">Add</button></div>
        <div class="onboard-selected">${state.onboarding.watchlist.length ? state.onboarding.watchlist.map(sym => `<span class="tag-pill">${esc(sym)} <b data-action="onboarding-toggle-symbol" data-symbol="${esc(sym)}" style="cursor:pointer">✕</b></span>`).join('') : '<span class="tiny faint">No instruments selected yet.</span>'}</div>
      </div>
      <div class="modal-actions"><button type="button" class="btn" data-action="onboarding-skip">Skip for now</button>
        <button type="submit" class="btn btn-primary">Finish setup →</button></div>
    </form>`, true);
}

function finishOnboarding() {
  const theme = state.onboarding.theme === 'light' ? 'light' : 'dark';
  const watchlist = [...new Set(state.onboarding.watchlist.filter(Boolean))];
  store.setPref('theme', theme);
  store.updateData(d => {
    d.watchlist = watchlist;
    d.settings.onboardingComplete = true;
  });
  closeModal();
  toast('Your workspace is ready.');
  go(ROUTES.overview);
}

/* ---------------------------- modals ---------------------------- */

function holdingModal(id = null) {
  const h = id ? store.data().holdings.find(x => x.id === id) : null;
  const inst = h ? instrumentFor(h.symbol) : null;
  openModal(`${modalHead(h ? `Edit ${esc(h.symbol)}` : 'Add an investment', h ? 'Update your position details.' : 'Track any stock, fund or other asset.')}
    <form id="holding-form">
      <input type="hidden" name="holdingId" value="${esc(h?.id || '')}"/>
      <div class="field"><label for="h-symbol">Ticker / symbol</label>
        <div class="autocomplete"><input class="input" id="h-symbol" name="symbol" autocomplete="off" placeholder="e.g. VOO, AAPL, BTC" value="${esc(h?.symbol || '')}" required/>
          <div class="autocomplete-list hidden" id="symbol-suggestions"></div></div>
        <span class="faint tiny" id="symbol-preview">${h ? esc(inst.name) : 'Start typing to search the Meridian catalog and global exchanges.'}</span></div>
      <div class="form-grid">
        <div class="field"><label for="h-quantity">Quantity</label><input class="input" id="h-quantity" name="quantity" type="number" step="any" min="0" value="${h?.quantity ?? ''}" placeholder="10" required/></div>
        <div class="field"><label for="h-cost">Average cost per unit</label><input class="input" id="h-cost" name="avgCost" type="number" step="any" min="0" value="${h?.avgCost ?? ''}" placeholder="125.50" required/></div>
      </div>
      <div class="form-grid">
        <div class="field"><label for="h-type">Asset class</label><select class="input" id="h-type" name="type">${['Stock','ETF','Mutual Fund','Crypto','Bond','Commodity','REIT'].map(t => `<option ${inst?.type === t ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
        <div class="field"><label for="h-exchange">Exchange (optional)</label><input class="input" id="h-exchange" name="exchange" value="${esc(h?.exchange || inst?.exchange || '')}" placeholder="NASDAQ"/></div>
      </div>
      <div class="form-error" id="holding-error"></div>
      <div class="modal-actions"><button type="button" class="btn" data-action="modal-close">Cancel</button>
        <button type="submit" class="btn btn-primary">${h ? 'Save changes' : 'Add investment'}</button></div>
    </form>`);
}

function goalModal() {
  openModal(`${modalHead('New goal', 'Set a target for your portfolio.')}
    <form id="goal-form">
      <div class="field"><label for="g-name">Goal name</label><input class="input" id="g-name" name="name" placeholder="e.g. Early retirement" required/></div>
      <div class="form-grid"><div class="field"><label for="g-target">Target amount</label><input class="input" id="g-target" name="target" type="number" min="1" step="any" placeholder="250000" required/></div>
        <div class="field"><label for="g-deadline">Target date</label><input class="input" id="g-deadline" name="deadline" type="date"/></div></div>
      <div class="field"><label for="g-icon">Icon</label><select class="input" id="g-icon" name="icon"><option value="◈">◈ General</option><option value="⌂">⌂ Home</option><option value="✈">✈ Travel</option><option value="◎">◎ Independence</option><option value="✦">✦ Education</option></select></div>
      <div class="form-error" id="goal-error"></div>
      <div class="modal-actions"><button type="button" class="btn" data-action="modal-close">Cancel</button><button type="submit" class="btn btn-primary">Create goal</button></div>
    </form>`);
}

function watchModal() {
  openModal(`${modalHead('Add to watchlist', 'Follow an instrument without owning it.')}
    <form id="watch-form">
      <div class="field"><label for="w-symbol">Ticker / symbol</label>
        <div class="autocomplete"><input class="input" id="w-symbol" name="symbol" autocomplete="off" placeholder="e.g. TSLA" required/>
          <div class="autocomplete-list hidden" id="symbol-suggestions"></div></div></div>
      <div class="form-error" id="watch-error"></div>
      <div class="modal-actions"><button type="button" class="btn" data-action="modal-close">Cancel</button><button type="submit" class="btn btn-primary">Add to watchlist</button></div>
    </form>`);
}

function articleModal(index) {
  const n = state.newsItems[index];
  if (!n) return;
  openModal(`${modalHead(n.source || 'news', '')}
    <span class="badge ${n.demo ? 'neutral' : 'live'}">${n.demo ? 'Sample briefing' : 'Live headline'}</span>
    <h3 style="font-size:23px;margin:16px 0 10px">${esc(n.title)}</h3>
    <p class="muted small">${esc(dateLabel(n.published))}</p>
    <p style="margin-top:18px">${esc(n.summary || 'Open the original story for the full article.')}</p>
    <div class="modal-actions">${n.url && n.url.startsWith('http') ? `<a class="btn btn-primary" href="${esc(n.url)}" target="_blank" rel="noopener">Read original story ↗</a>` : ''}
      <button class="btn" data-action="modal-close">Close</button></div>`, true);
}

function importModal() {
  openModal(`${modalHead('Import portfolio', 'Paste a Meridian Finance JSON export.')}
    <form id="import-form"><div class="field"><label for="import-json">JSON data</label><textarea class="input" id="import-json" style="min-height:220px;font-family:monospace;font-size:11px" required></textarea></div>
      <div class="form-error" id="import-error"></div>
      <div class="modal-actions"><button type="button" class="btn" data-action="modal-close">Cancel</button><button type="submit" class="btn btn-primary">Import data</button></div></form>`);
}

/* ---------------------------- render ---------------------------- */

function render({ preserve = false } = {}) {
  const y = preserve ? window.scrollY : 0;
  const r = route();
  document.documentElement.dataset.theme = store.getPrefs().theme || 'dark';
  const pageTitle = r.page === 'overview' ? 'Overview' : r.page === 'ai' ? 'Meridian AI' : String(r.page || '').replace(/^./, c => c.toUpperCase());
  document.title = r.mode === 'app' ? `${pageTitle} · ${BRAND.dba}` : `${BRAND.product} — ${BRAND.tagline}`;

  if (r.mode === 'app' && !store.currentUser()) {
    location.replace('#/login');
    return;
  }

  if (r.mode === 'landing') root.innerHTML = landing();
  else if (r.mode === 'login') root.innerHTML = authPage();
  else {
    let content = '';
    if (r.page === 'overview') content = overviewPage();
    else if (r.page === 'portfolio') content = portfolioPage();
    else if (r.page === 'discover') content = discoverPage();
    else if (r.page === 'markets') content = marketsPage();
    else if (r.page === 'news') content = newsPage();
    else if (r.page === 'watchlist') content = watchlistPage();
    else if (r.page === 'goals') content = goalsPage();
    else if (r.page === 'ai') content = aiPage();
    else if (r.page === 'settings') content = settingsPage();
    else if (r.page === 'instrument') content = instrumentPage(r.param);
    else content = overviewPage();
    root.innerHTML = `<div class="shell">${sidebar()}<div class="main">${topbar()}<main class="page">${content}</main></div></div>`;
  }

  attachChartHover(root);
  paintAiStatus();
  paintConnectorStatus();
  if (r.mode === 'app' && r.page === 'ai') scrollAiToBottom();
  if (preserve) window.scrollTo(0, y);

  if (r.mode === 'landing') ensureLandingNews();
  if (r.mode === 'app') {
    ensureQuotes();
    if (r.page === 'news') { ensureNews(); if (!state.newsItems.length) ensureNews(); }
    if (r.page === 'instrument' && r.param) { ensureSeries(r.param); ensureOverview(r.param); }
  }
}

/* ---------------------------- events ---------------------------- */

document.addEventListener('click', async e => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;

  if (action === 'modal-backdrop' && e.target === el) {
    if ($('#onboarding-form')) finishOnboarding(); else closeModal();
    return;
  }
  if (action === 'modal-close') {
    if ($('#onboarding-form')) finishOnboarding(); else closeModal();
    return;
  }
  if (action === 'nav') { e.preventDefault(); go(el.getAttribute('href') || '#/app/overview'); return; }
  if (action === 'toggle-theme') {
    const next = store.getPrefs().theme === 'light' ? 'dark' : 'light';
    store.setPref('theme', next);
    toast(next === 'light' ? 'Daylight theme enabled.' : 'Midnight theme enabled.');
    render({ preserve: true }); return;
  }
  if (action === 'go-login') { state.authMode = 'signin'; go(ROUTES.login); return; }
  if (action === 'go-signup') { state.authMode = 'signup'; go(ROUTES.login); return; }
  if (action === 'auth-mode') { e.preventDefault(); state.authMode = el.dataset.mode; render(); return; }
  if (action === 'ai-prompt') {
    state.aiPrefill = el.dataset.prompt || '';
    go(ROUTES.ai);
    setTimeout(() => {
      const input = $('#ai-input');
      if (input) {
        input.value = state.aiPrefill;
        input.focus();
        input.setSelectionRange(state.aiPrefill.length, state.aiPrefill.length);
      }
    }, 60);
    return;
  }
  if (action === 'ai-model') {
    if (state.aiBusy) { toast('Wait for the current answer to finish.', 'error'); return; }
    const modelId = el.dataset.model;
    store.setPref('aiModel', modelId);
    state.aiError = '';
    if (ai.activeModel() && ai.activeModel() !== modelId) {
      await ai.unload();
      state.aiProgress = null;
      toast('Model changed. Load it when you are ready.');
    }
    render({ preserve: true }); return;
  }
  if (action === 'ai-load') { await loadAIModel(); return; }
  if (action === 'ai-toggle-context') {
    state.aiContext[el.dataset.key] = !state.aiContext[el.dataset.key];
    render({ preserve: true }); return;
  }
  if (action === 'ai-clear') {
    state.aiMessages = [state.aiMessages[0]].filter(Boolean);
    state.aiBusy = false; state.aiProgress = null; state.aiError = '';
    ai.stop();
    render({ preserve: true }); toast('Conversation cleared.'); return;
  }
  if (action === 'ai-stop') {
    await ai.stop();
    state.aiBusy = false;
    render({ preserve: true }); toast('Generation stopped.'); return;
  }
  if (action === 'onboarding-theme') {
    state.onboarding.theme = el.dataset.theme;
    document.documentElement.dataset.theme = state.onboarding.theme;
    onboardingModal(); return;
  }
  if (action === 'onboarding-toggle-symbol') {
    const sym = String(el.dataset.symbol || '').toUpperCase();
    state.onboarding.watchlist = state.onboarding.watchlist.includes(sym)
      ? state.onboarding.watchlist.filter(s => s !== sym)
      : [...state.onboarding.watchlist, sym];
    onboardingModal(); return;
  }
  if (action === 'onboarding-add-symbol') {
    const input = $('#onboarding-symbol');
    const sym = String(input?.value || '').trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9.\-]{0,19}$/.test(sym)) { toast('Enter a valid ticker symbol.', 'error'); input?.focus(); return; }
    if (!state.onboarding.watchlist.includes(sym)) state.onboarding.watchlist.push(sym);
    onboardingModal(); return;
  }
  if (action === 'onboarding-skip') { finishOnboarding(); return; }
  if (action === 'connector-copy-code') { await copyPairingCode(); return; }
  if (action === 'connector-refresh-code') { await refreshPairCode(true); return; }
  if (action === 'connector-sync-now') { await syncNow(); return; }
  if (action === 'connector-disconnect') { disconnectCloud(); return; }
  if (action === 'demo') {
    store.openDemoAccount(); closeModal(); toast('Demo portfolio loaded. Welcome to Meridian.'); go(ROUTES.overview); return;
  }
  if (action === 'logout') { store.signOut(); toast('Signed out.'); go(ROUTES.landing); return; }
  if (action === 'refresh') { toast('Refreshing live prices…'); await ensureQuotes(true); return; }
  if (action === 'refresh-news') { state.newsQuery = ''; await ensureNews(true); toast('News feed refreshed.'); return; }
  if (action === 'range') { state.range = el.dataset.range; render({ preserve: true }); return; }
  if (action === 'open-instrument') { go(`#/app/instrument/${encodeURIComponent(el.dataset.symbol)}`); return; }
  if (action === 'search-result') {
    state.searchOpen = false; state.searchTerm = ''; state.searchResults = [];
    go(`#/app/instrument/${encodeURIComponent(el.dataset.symbol)}`);
    return;
  }
  if (action === 'sort') {
    const key = el.dataset.key;
    state.portfolioSort = { key, dir: state.portfolioSort.key === key ? -state.portfolioSort.dir : (key === 'symbol' ? 1 : -1) };
    render({ preserve: true }); return;
  }
  if (action === 'add-holding') {
    const sym = el.dataset.symbol;
    holdingModal(); if (sym) { $('#h-symbol').value = sym; $('#symbol-preview').textContent = instrumentFor(sym).name; }
    return;
  }
  if (action === 'quick-add') {
    const sym = el.dataset.symbol; holdingModal();
    $('#h-symbol').value = sym;
    $('#symbol-preview').textContent = instrumentFor(sym).name;
    const q = priceFor(sym);
    $('#h-cost').value = q.price ? q.price.toFixed(2) : '';
    return;
  }
  if (action === 'edit-holding') { holdingModal(el.dataset.id); return; }
  if (action === 'delete-holding') {
    confirmModal({ title: 'Remove this position?', body: 'This removes the holding from your portfolio. Your other data is unchanged.', action: 'confirm-delete-holding', id: el.dataset.id });
    return;
  }
  if (action === 'confirm-delete-holding') {
    store.updateData(d => { d.holdings = d.holdings.filter(h => h.id !== el.dataset.id); });
    closeModal(); toast('Position removed.'); render({ preserve: true }); return;
  }
  if (action === 'delete-tx') {
    store.updateData(d => { d.transactions = d.transactions.filter(t => t.id !== el.dataset.id); });
    toast('Transaction removed.'); render({ preserve: true }); return;
  }
  if (action === 'toggle-watch') {
    const sym = el.dataset.symbol;
    let added;
    store.updateData(d => {
      if (d.watchlist.includes(sym)) { d.watchlist = d.watchlist.filter(s => s !== sym); added = false; }
      else { d.watchlist.push(sym); added = true; }
    });
    toast(`${sym} ${added ? 'added to' : 'removed from'} watchlist.`); render({ preserve: true }); return;
  }
  if (action === 'add-watch') { watchModal(); return; }
  if (action === 'remove-watch') {
    store.updateData(d => { d.watchlist = d.watchlist.filter(s => s !== el.dataset.symbol); });
    toast('Removed from watchlist.'); render({ preserve: true }); return;
  }
  if (action === 'add-goal') { goalModal(); return; }
  if (action === 'delete-goal') {
    confirmModal({ title: 'Delete this goal?', body: 'Your portfolio and holdings are not affected.', action: 'confirm-delete-goal', id: el.dataset.id });
    return;
  }
  if (action === 'confirm-delete-goal') {
    store.updateData(d => { d.goals = d.goals.filter(g => g.id !== el.dataset.id); });
    closeModal(); toast('Goal deleted.'); render({ preserve: true }); return;
  }
  if (action === 'discover-type') { state.discoverType = el.dataset.type; render({ preserve: true }); return; }
  if (action === 'market-region') { state.marketRegion = el.dataset.region; render({ preserve: true }); return; }
  if (action === 'exchange') {
    state.discoverType = 'All'; state.discoverQuery = el.dataset.code;
    go(ROUTES.discover); setTimeout(() => { const input = $('#discover-input'); if (input) input.focus(); }, 50); return;
  }
  if (action === 'news-category') {
    state.newsCategory = el.dataset.category; state.newsQuery = ''; state.newsItems = [];
    render({ preserve: true }); return;
  }
  if (action === 'article') { state.article = state.newsItems[Number(el.dataset.index)]; articleModal(Number(el.dataset.index)); return; }
  if (action === 'export') {
    const blob = new Blob([store.exportData()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `meridian-portfolio-${new Date().toISOString().slice(0, 10)}.json`;
    a.click(); URL.revokeObjectURL(url); toast('Portfolio exported.'); return;
  }
  if (action === 'import') { importModal(); return; }
  if (action === 'reset-demo') {
    confirmModal({ title: 'Reset demo data?', body: 'This restores the original sample portfolio, watchlist and goals.', action: 'confirm-reset-demo', id: 'demo' });
    return;
  }
  if (action === 'confirm-reset-demo') { store.resetDemoData(); closeModal(); toast('Demo data restored.'); render(); return; }
  if (action === 'delete-account') {
    confirmModal({ title: 'Delete your account?', body: 'Your locally stored account and portfolio will be permanently removed from this browser.', action: 'confirm-delete-account', id: 'me' });
    return;
  }
  if (action === 'confirm-delete-account') { store.deleteAccount(); closeModal(); toast('Account deleted.'); go(ROUTES.landing); return; }
  if (action === 'toggle-mobile-nav') {
    document.querySelector('.sidebar').classList.toggle('mobile-open');
    toast('Use the bottom navigation to move between pages.'); return;
  }
});

/* ---------------------------- forms ---------------------------- */

document.addEventListener('submit', async e => {
  const form = e.target;
  e.preventDefault();

  if (form.id === 'signin-form' || form.id === 'signup-form') {
    const button = form.querySelector('button[type=submit]');
    button.disabled = true;
    const fd = new FormData(form);
    const result = form.id === 'signup-form'
      ? await store.createUser({ name: fd.get('name'), email: fd.get('email'), password: fd.get('password') })
      : await store.signIn(fd.get('email'), fd.get('password'));
    button.disabled = false;
    if (!result.ok) { $('#auth-error').textContent = result.error; return; }
    if (form.id === 'signup-form') {
      state.onboarding = { theme: store.getPrefs().theme || 'dark', watchlist: [] };
      toast('Account created. Let’s personalize your workspace.');
      onboardingModal();
      return;
    }
    toast(`Welcome back, ${result.user.name}.`);
    if (!store.getPrefs().onboardingComplete) {
      state.onboarding = { theme: store.getPrefs().theme || 'dark', watchlist: [...store.data().watchlist] };
      onboardingModal();
      return;
    }
    go(ROUTES.overview);
    return;
  }

  if (form.id === 'onboarding-form') { finishOnboarding(); return; }

  if (form.id === 'connector-form') {
    const fd = new FormData(form);
    await connectCloud(fd.get('email'), fd.get('password'));
    return;
  }

  if (form.id === 'ai-chat-form') {
    const input = $('#ai-input');
    const question = input?.value || '';
    if (!question.trim()) return;
    input.value = '';
    await askAI(question);
    return;
  }

  if (form.id === 'holding-form') {
    const fd = new FormData(form);
    const symbol = String(fd.get('symbol') || '').trim().toUpperCase();
    const quantity = Number(fd.get('quantity'));
    const avgCost = Number(fd.get('avgCost'));
    const err = $('#holding-error');
    if (!symbol) { err.textContent = 'Enter a ticker symbol.'; return; }
    if (!(quantity > 0) || !(avgCost >= 0)) { err.textContent = 'Enter a valid quantity and average cost.'; return; }
    const inst = instrumentFor(symbol);
    const id = fd.get('holdingId');
    store.updateData(d => {
      if (id) {
        d.holdings = d.holdings.map(h => h.id === id ? { ...h, symbol, quantity, avgCost, type: fd.get('type'), exchange: fd.get('exchange') || h.exchange } : h);
      } else {
        d.holdings.push({ id: uid('h'), symbol, name: inst.name, quantity, avgCost, type: fd.get('type'), exchange: fd.get('exchange') || inst.exchange, currency: inst.currency || currency(), addedAt: Date.now() });
        d.transactions.push({ id: uid('tx'), symbol, type: 'Buy', quantity, price: avgCost, date: Date.now(), note: 'Added to portfolio' });
      }
    });
    closeModal(); toast(`${symbol} ${id ? 'updated' : 'added to your portfolio'}.`); render({ preserve: true }); return;
  }

  if (form.id === 'goal-form') {
    const fd = new FormData(form);
    const name = String(fd.get('name') || '').trim();
    const target = Number(fd.get('target'));
    if (!name || !(target > 0)) { $('#goal-error').textContent = 'Give your goal a name and a positive target.'; return; }
    store.updateData(d => { d.goals.push({ id: uid('goal'), name, target, deadline: fd.get('deadline'), icon: fd.get('icon'), color: colorFor(name) }); });
    closeModal(); toast('Goal created.'); render({ preserve: true }); return;
  }

  if (form.id === 'watch-form') {
    const symbol = String(new FormData(form).get('symbol') || '').trim().toUpperCase();
    if (!symbol) { $('#watch-error').textContent = 'Enter a ticker symbol.'; return; }
    let added = true;
    store.updateData(d => { if (d.watchlist.includes(symbol)) added = false; else d.watchlist.push(symbol); });
    closeModal(); toast(added ? `${symbol} added to watchlist.` : `${symbol} is already on your watchlist.`); render({ preserve: true }); return;
  }

  if (form.id === 'import-form') {
    const result = store.importData($('#import-json').value);
    if (!result.ok) { $('#import-error').textContent = result.error || 'Import failed.'; return; }
    closeModal(); toast('Portfolio imported.'); render(); return;
  }

  if (form.id === 'api-key-form') {
    store.setPref('apiKey', String(new FormData(form).get('apiKey') || '').trim());
    toast('API key saved locally.'); return;
  }
});

/* ---------------------------- inputs / keyboard ---------------------------- */

const runDiscoverSearch = debounce(async value => {
  state.discoverQuery = value;
  if (value.trim().length >= 2) {
    const results = await api.searchSymbols(value.trim());
    state.discoverRemote = results;
    render({ preserve: true });
    setTimeout(() => { const input = $('#discover-input'); if (input) { input.focus(); input.setSelectionRange(value.length, value.length); } }, 0);
  } else { state.discoverRemote = []; render({ preserve: true }); }
}, 420);

const runGlobalSearch = debounce(async value => {
  if (value.trim().length < 2) { state.searchResults = INSTRUMENTS.slice(0, 6); renderSearchResults(); return; }
  const results = await api.searchSymbols(value.trim());
  state.searchResults = results;
  renderSearchResults();
}, 300);

const runSymbolAutocomplete = debounce(async value => {
  const list = $('#symbol-suggestions');
  if (!list) return;
  if (value.trim().length < 2) { list.classList.add('hidden'); return; }
  const results = await api.searchSymbols(value.trim());
  list.innerHTML = results.slice(0, 7).map(r => `<div class="autocomplete-item" data-action="fill-symbol" data-symbol="${esc(r.symbol)}" data-name="${esc(r.name)}">
    <b>${esc(r.symbol)}</b><span class="muted">${esc(r.name)}</span></div>`).join('');
  list.classList.remove('hidden');
}, 320);

function renderSearchResults() {
  const host = $('#search-results');
  if (host) host.innerHTML = searchResultsMarkup();
}

document.addEventListener('input', e => {
  const el = e.target;
  if (el.id === 'global-search') {
    state.searchTerm = el.value; state.searchOpen = true; state.searchSelected = 0;
    if (!$('#search-results')) { /* dropdown appears on next render */ render({ preserve: true }); setTimeout(() => $('#global-search')?.focus(), 0); }
    else renderSearchResults();
    runGlobalSearch(el.value);
  }
  if (el.id === 'discover-input') {
    state.discoverQuery = el.value;
    runDiscoverSearch(el.value);
  }
  if (el.id === 'market-input') { state.marketQuery = el.value; render({ preserve: true }); setTimeout(() => { const i = $('#market-input'); i?.focus(); i?.setSelectionRange(el.value.length, el.value.length); }, 0); }
  if (el.id === 'news-input') { state.newsQuery = el.value; }
  if (el.id === 'h-symbol' || el.id === 'w-symbol') {
    runSymbolAutocomplete(el.value);
    const inst = INSTRUMENT_MAP[el.value.trim().toUpperCase()];
    const preview = $('#symbol-preview');
    if (preview) preview.textContent = inst?.name || 'Searching global exchanges…';
    if (el.id === 'h-symbol' && inst) {
      const typeSelect = $('#h-type');
      if (typeSelect) typeSelect.value = inst.type;
      const exchange = $('#h-exchange');
      if (exchange && !exchange.value) exchange.value = inst.exchange;
    }
  }
});

document.addEventListener('change', async e => {
  const el = e.target;
  if (el.id === 'sync-endpoint') {
    const value = String(el.value || '').trim();
    if (!/^https?:\/\/[^\s]+$/i.test(value)) {
      toast('Enter a full http:// or https:// sync server URL.', 'error');
      el.value = connector.endpoint();
      return;
    }
    const previous = connector.endpoint();
    connector.setEndpoint(value);
    if (previous !== connector.endpoint() && connector.status().connected) {
      if (cloudUnsubscribe) { cloudUnsubscribe(); cloudUnsubscribe = null; }
      startCloudSubscription();
      pushSnapshot(false);
    }
    toast('Sync server URL saved.');
    return;
  }
  if (el.id === 'theme-select') { store.setPref('theme', el.value); render({ preserve: true }); }
  if (el.id === 'currency-select') { store.setPref('currency', el.value); toast(`Display currency set to ${el.value}.`); render({ preserve: true }); }
  if (el.id === 'settings-ai-model' || el.id === 'ai-model-select') {
    store.setPref('aiModel', el.value);
    if (ai.activeModel() && ai.activeModel() !== el.value) { await ai.unload(); state.aiProgress = null; }
    toast('Local AI model selected.');
    render({ preserve: true });
  }
});

document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    const input = $('#global-search');
    if (input) { e.preventDefault(); input.focus(); state.searchOpen = true; renderSearchResults(); }
  }
  if (e.key === 'Enter' && e.target?.id === 'onboarding-symbol') {
    e.preventDefault();
    const sym = String(e.target.value || '').trim().toUpperCase();
    if (/^[A-Z0-9][A-Z0-9.\-]{0,19}$/.test(sym)) {
      if (!state.onboarding.watchlist.includes(sym)) state.onboarding.watchlist.push(sym);
      onboardingModal();
    } else toast('Enter a valid ticker symbol.', 'error');
    return;
  }
  if (e.key === 'Escape') {
    if ($('#onboarding-form')) finishOnboarding();
    else if (modalHost.innerHTML) closeModal();
    else if (state.searchOpen) { state.searchOpen = false; render({ preserve: true }); }
  }
  if ($('#search-results') && ['ArrowDown', 'ArrowUp'].includes(e.key)) {
    e.preventDefault();
    state.searchSelected = clamp(state.searchSelected + (e.key === 'ArrowDown' ? 1 : -1), 0, Math.max(state.searchResults.length - 1, 0));
    renderSearchResults();
  }
  if (e.key === 'Enter' && $('#search-results') && state.searchResults[state.searchSelected] && document.activeElement?.id === 'global-search') {
    const r = state.searchResults[state.searchSelected];
    state.searchOpen = false; state.searchTerm = '';
    go(`#/app/instrument/${encodeURIComponent(r.symbol)}`);
  }
});

document.addEventListener('click', e => {
  const fill = e.target.closest('[data-action="fill-symbol"]');
  if (!fill) return;
  const input = $('#h-symbol') || $('#w-symbol');
  if (input) input.value = fill.dataset.symbol;
  const preview = $('#symbol-preview');
  if (preview) preview.textContent = fill.dataset.name;
  $('#symbol-suggestions')?.classList.add('hidden');
});

document.addEventListener('click', e => {
  if (!e.target.closest('.global-search') && state.searchOpen) {
    state.searchOpen = false;
    const host = $('#search-results');
    if (host) host.remove();
  }
});

window.addEventListener('hashchange', () => { closeModal(); render(); });

/* ---------------------------- boot ---------------------------- */
state.aiMessages.push({
  id: 'ai-welcome',
  role: 'assistant',
  content: 'Hi — I’m Meridian AI. I run locally in this browser, so your portfolio never leaves your device. Ask me to explain a holding, summarize your book, or connect the latest headlines to what you own.\n\nI explain information for educational purposes; I do not provide personal investment advice.',
});
ai.setProgressHandler(progress => {
  state.aiProgress = progress;
  paintAiStatus();
});

/* Meridian Connector: auto-push local changes and listen for cloud updates. */
Object.assign(state.connector, {
  connected: connector.status().connected,
  user: connector.status().user,
  lastSyncAt: connector.status().lastSyncAt,
});
const pushCloudDebounced = debounce(() => { pushSnapshot(false); }, 900);
window.addEventListener('meridian:data-changed', () => {
  if (applyingRemote || !connector.status().connected) return;
  pushCloudDebounced();
});
if (state.connector.connected) startCloudSubscription();

initCalendarWidget({
  app: 'meridian',
  getEndpoint: connector.endpoint,
  getToken: connector.cloudToken,
});

render();
ai.detectAI().then(available => {
  if (!available && route().page === 'ai') render({ preserve: true });
});
