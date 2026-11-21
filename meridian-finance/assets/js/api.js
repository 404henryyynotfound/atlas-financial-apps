/* Market data adapters: Alpha Vantage (quotes, search, history, fundamentals)
   + Google News via rss2json for editorial. Every call is cached and degrades
   gracefully to local demo data so the app never shows an empty screen. */
import { API_KEY, STORAGE } from './config.js';
import { INSTRUMENTS, INSTRUMENT_MAP, FALLBACK_NEWS } from './data.js';
import { safeParse, stripHtml, syntheticSeries } from './utils.js';

const AV = 'https://www.alphavantage.co/query';
const DAILY_LIMIT = 20; // stay below the free-tier ceiling of 25/day

function readCache(key) { return safeParse(localStorage.getItem(key), null); }
function writeCache(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full — non-fatal */ }
}

export function getApiKey() {
  const prefs = readCache(STORAGE.prefs) || {};
  return prefs.apiKey || API_KEY || '';
}

function budget() {
  const day = new Date().toISOString().slice(0, 10);
  const state = readCache('meridian.api.budget') || { day, count: 0 };
  if (state.day !== day) { state.day = day; state.count = 0; }
  return state;
}

function spend(amount = 1) {
  const state = budget();
  state.count += amount;
  writeCache('meridian.api.budget', state);
  return state.count <= DAILY_LIMIT;
}

export function apiStatus() {
  const state = budget();
  return { used: state.count, limit: DAILY_LIMIT, remaining: Math.max(0, DAILY_LIMIT - state.count) };
}

async function avFetch(params, { count = true } = {}) {
  if (count && budget().count >= DAILY_LIMIT) return null;
  if (count) spend();
  const key = getApiKey();
  if (!key) return null; // No bundled key: fall back to cached/sample data.
  const url = new URL(AV);
  Object.entries({ apikey: key, ...params }).forEach(([k, v]) => url.searchParams.set(k, v));
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) return null;
    const json = await res.json();
    if (json.Note || json.Information) return null; // throttle / premium message
    if (json['Error Message']) return null;
    return json;
  } catch { return null; }
}

export function localInstrument(symbol) {
  return INSTRUMENT_MAP[String(symbol || '').toUpperCase()] || null;
}

function demoQuote(symbol) {
  const inst = localInstrument(symbol);
  const price = inst?.price || 100;
  return {
    symbol: String(symbol).toUpperCase(), price, change: price * (inst?.changePct || 0) / 100,
    changePct: inst?.changePct || 0, open: price * 0.995, high: price * 1.006, low: price * 0.992,
    previousClose: price / (1 + (inst?.changePct || 0) / 100), volume: 0,
    updatedAt: Date.now(), live: false,
  };
}

export async function getQuote(symbol, { force = false } = {}) {
  const sym = String(symbol || '').toUpperCase();
  if (!sym) return null;
  const cache = readCache(STORAGE.quotes) || {};
  const hit = cache[sym];
  if (!force && hit && Date.now() - hit.updatedAt < 30 * 60 * 1000) return hit;
  const json = await avFetch({ function: 'GLOBAL_QUOTE', symbol: sym });
  const q = json?.['Global Quote'];
  let result = null;
  if (q && Number(q['05. price']) > 0) {
    result = {
      symbol: sym,
      price: Number(q['05. price']),
      change: Number(q['09. change']) || 0,
      changePct: Number(String(q['10. change percent'] || '0').replace('%', '')) || 0,
      open: Number(q['02. open']) || 0,
      high: Number(q['03. high']) || 0,
      low: Number(q['04. low']) || 0,
      previousClose: Number(q['08. previous close']) || 0,
      volume: Number(q['06. volume']) || 0,
      tradingDay: q['07. latest trading day'] || '',
      updatedAt: Date.now(), live: true,
    };
  } else if (hit) {
    result = { ...hit, stale: true };
  } else {
    result = demoQuote(sym);
  }
  cache[sym] = result;
  writeCache(STORAGE.quotes, cache);
  return result;
}

export async function getQuotes(symbols, { force = false, limit = 12 } = {}) {
  const unique = [...new Set(symbols.filter(Boolean).map(s => String(s).toUpperCase()))].slice(0, limit);
  const result = {};
  const cache = readCache(STORAGE.quotes) || {};
  const pending = [];
  for (const sym of unique) {
    const hit = cache[sym];
    if (!force && hit && Date.now() - hit.updatedAt < 30 * 60 * 1000) result[sym] = hit;
    else pending.push(sym);
  }
  // Small batches keep the free-tier request budget predictable.
  for (let i = 0; i < pending.length; i += 2) {
    const batch = pending.slice(i, i + 2);
    const values = await Promise.all(batch.map(s => getQuote(s, { force })));
    batch.forEach((s, j) => { result[s] = values[j] || demoQuote(s); });
  }
  unique.forEach(s => { if (!result[s]) result[s] = cache[s] || demoQuote(s); });
  return result;
}

export async function searchSymbols(keywords) {
  const term = String(keywords || '').trim();
  if (term.length < 2) return [];
  const cache = readCache(STORAGE.search) || {};
  const key = term.toLowerCase();
  if (cache[key] && Date.now() - cache[key].at < 86400000) return cache[key].items;
  const json = await avFetch({ function: 'SYMBOL_SEARCH', keywords: term });
  const remote = (json?.bestMatches || []).map(m => ({
    symbol: m['1. symbol'], name: m['2. name'], type: m['3. type'],
    exchange: m['4. region'], currency: m['8. currency'],
  }));
  const local = INSTRUMENTS.filter(i => `${i.symbol} ${i.name}`.toLowerCase().includes(key))
    .map(i => ({ symbol: i.symbol, name: i.name, type: i.type, exchange: i.exchange, currency: i.currency }));
  const merged = [...local];
  remote.forEach(r => { if (!merged.some(x => x.symbol.toUpperCase() === r.symbol.toUpperCase())) merged.push(r); });
  const items = merged.slice(0, 12);
  cache[key] = { at: Date.now(), items };
  writeCache(STORAGE.search, cache);
  return items;
}

export async function getDailySeries(symbol) {
  const sym = String(symbol || '').toUpperCase();
  const cache = readCache(STORAGE.series) || {};
  const hit = cache[sym];
  if (hit && Date.now() - hit.at < 12 * 3600000) return hit.items;
  const json = await avFetch({ function: 'TIME_SERIES_DAILY', symbol: sym, outputsize: 'compact' });
  const ts = json?.['Time Series (Daily)'];
  let items = [];
  if (ts) {
    items = Object.entries(ts).map(([date, v]) => ({ date, close: Number(v['4. close']) }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }
  if (!items.length && hit) items = hit.items;
  if (!items.length) {
    const q = cacheQuote(sym) || demoQuote(sym);
    items = syntheticSeries(sym, q.price, 252, q.changePct);
  }
  cache[sym] = { at: Date.now(), items: items.slice(-252) };
  writeCache(STORAGE.series, cache);
  return cache[sym].items;
}

function cacheQuote(symbol) {
  return (readCache(STORAGE.quotes) || {})[symbol] || null;
}

export async function getOverview(symbol) {
  const sym = String(symbol || '').toUpperCase();
  const cache = readCache('meridian.overviews.v1') || {};
  if (cache[sym] && Date.now() - cache[sym].at < 7 * 86400000) return cache[sym].data;
  const json = await avFetch({ function: 'OVERVIEW', symbol: sym });
  const d = json && json.Symbol ? {
    name: json.Name, sector: json.Sector, industry: json.Industry,
    marketCap: json.MarketCapitalization, peRatio: json.PERatio,
    dividendYield: json.DividendYield, beta: json.Beta,
    high52: json['52WeekHigh'], low52: json['52WeekLow'],
    description: json.Description,
  } : null;
  if (d) { cache[sym] = { at: Date.now(), data: d }; writeCache('meridian.overviews.v1', cache); }
  return d;
}

/* News: Google News RSS via rss2json (CORS-friendly). Fresh per topic and
   cached; falls back to clearly-labelled Meridian Briefing stories. */
export async function getNews({ query = 'stock market', category = 'all', force = false } = {}) {
  const cache = readCache(STORAGE.news) || {};
  const key = `${category}:${query}`;
  const hit = cache[key];
  if (!force && hit && Date.now() - hit.at < 20 * 60 * 1000) return hit.items;

  const rss = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
  const url = `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(rss)}&count=18`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
    const json = await res.json();
    const items = (json.items || []).map((item, i) => {
      const rawTitle = stripHtml(item.title || '');
      const source = item.source || rawTitle.split(' - ').pop() || 'Google News';
      return {
        id: `${key}-${i}-${item.guid || i}`,
        title: rawTitle.replace(/\s+-\s+[^-]+$/, ''),
        url: item.link,
        source,
        published: Date.parse(String(item.pubDate).replace(' ', 'T') + (item.pubDate?.includes('Z') ? '' : 'Z')) || Date.now(),
        summary: stripHtml(item.description || '').slice(0, 260),
        image: item.thumbnail || item.enclosure?.link || '',
        category, demo: false,
      };
    }).filter(x => x.title && x.url).slice(0, 14);
    if (items.length) {
      cache[key] = { at: Date.now(), items };
      writeCache(STORAGE.news, cache);
      return items;
    }
  } catch { /* offline or rate limited */ }
  if (hit) return hit.items;
  return FALLBACK_NEWS.map((n, i) => ({
    ...n, id: `brief-${i}`, url: '#/app/news', published: Date.now() - n.minutesAgo * 60000,
    image: '', demo: true,
  }));
}
