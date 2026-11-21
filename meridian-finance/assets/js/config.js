/* Meridian Finance — configuration and brand constants. */
export const BRAND = {
  legal: 'Atlas Financial',
  dba: 'Meridian Finance',
  product: 'Meridian',
  tagline: 'Every market. One clear view.',
  domain: 'meridian-finance.surge.sh',
  year: new Date().getFullYear(),
};

/* No market-data key is bundled. A host can inject one at deploy time with
   window.ATLAS_CONFIG.alphaVantageKey; users can also enter their own key in
   Settings. Without a key, Meridian stays fully usable with cached/sample data. */
const injectedConfig = (typeof window !== 'undefined' && window.ATLAS_CONFIG && typeof window.ATLAS_CONFIG === 'object')
  ? window.ATLAS_CONFIG
  : {};

export const API_KEY = injectedConfig.alphaVantageKey || injectedConfig.alphaVantageApiKey || '';

export const STORAGE = {
  users: 'meridian.users.v1',
  session: 'meridian.session.v1',
  dataPrefix: 'meridian.data.v1.',
  quotes: 'meridian.quotes.v1',
  series: 'meridian.series.v1',
  search: 'meridian.search.v1',
  news: 'meridian.news.v1',
  prefs: 'meridian.prefs.v1',
};

export const ROUTES = {
  landing: '#/',
  login: '#/login',
  overview: '#/app/overview',
  portfolio: '#/app/portfolio',
  markets: '#/app/markets',
  discover: '#/app/discover',
  news: '#/app/news',
  watchlist: '#/app/watchlist',
  goals: '#/app/goals',
  ai: '#/app/ai',
  settings: '#/app/settings',
};

/* On-device AI. No API key, no provider quota — models download once and
   then run locally through WebGPU. Users can change the model at any time. */
export const AI_MODELS = [
  { id: 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC', label: 'Quick', note: 'Smallest download · fastest replies' },
  { id: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC', label: 'Balanced', note: 'Recommended · good answer quality' },
  { id: 'Llama-3.2-3B-Instruct-q4f16_1-MLC', label: 'Deeper', note: 'Larger download · more capable' },
];
export const DEFAULT_AI_MODEL = AI_MODELS[1].id;

export const AI_SYSTEM_PROMPT = `You are Meridian AI, a private on-device assistant inside Meridian Finance, a product of Atlas Financial.
You help users understand their own portfolio data, watched instruments, goals and market headlines.
Rules:
- Be clear, concise and practical. Prefer short paragraphs and bullet points.
- Explain financial concepts in plain English.
- Never claim to place trades, move money, or access live brokerage accounts.
- Never provide personalised buy, sell or hold recommendations.
- When interpreting a portfolio, say that the information is educational and not financial advice.
- If data is missing or simulated, say so rather than inventing details.
- Always use the portfolio context provided by the app; do not assume unstated holdings.`;

export const SUGGESTED_WATCHLIST = ['AAPL', 'NVDA', 'MSFT', 'TSLA', 'VTI', 'VOO', 'QQQ', 'GLD', 'BTC', 'SAP', 'TSM', 'JNJ'];

export const ASSET_TYPES = ['Stock', 'ETF', 'Mutual Fund', 'Crypto', 'Bond', 'Commodity', 'REIT'];

export const TYPE_COLORS = {
  Stock: '#5f8cff',
  ETF: '#4fd1c5',
  'Mutual Fund': '#a78bfa',
  Crypto: '#f5a524',
  Bond: '#60a5fa',
  Commodity: '#e8c268',
  REIT: '#f472b6',
  Cash: '#94a3b8',
};

export const SECTOR_COLORS = [
  '#5f8cff', '#4fd1c5', '#a78bfa', '#f5a524', '#f472b6',
  '#34d399', '#fb7185', '#38bdf8', '#e8c268', '#818cf8',
];

export const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF', 'INR', 'BRL'];
