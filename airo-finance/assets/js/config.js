/* Airo Finance — configuration and brand constants.
   A product of Atlas Financial. No bundler, no runtime dependencies. */
export const BRAND = {
  legal: 'Atlas Financial',
  dba: 'Airo Finance',
  product: 'Airo',
  tagline: 'Money, made clear.',
  domain: 'airo-finance.surge.sh',
  year: new Date().getFullYear(),
};

export const STORAGE = {
  users: 'airo.users.v1',
  session: 'airo.session.v1',
  dataPrefix: 'airo.data.v1.',
  prefs: 'airo.prefs.v1',
  clientId: 'airo.clientId.v1',
  syncEndpoint: 'airo.syncEndpoint',
  syncMeta: 'airo.syncMeta.v1',
};

export const DEFAULT_SYNC_ENDPOINT = 'https://atlas-sync.greenhenry441.workers.dev';
export const SYNC_APP = 'airo';
export const MERIDIAN_APP = 'meridian';

export const ROUTES = {
  landing: '#/',
  signin: '#/signin',
  signup: '#/signup',
  overview: '#/app/overview',
  accounts: '#/app/accounts',
  transactions: '#/app/transactions',
  budgets: '#/app/budgets',
  recurring: '#/app/recurring',
  goals: '#/app/goals',
  retirement: '#/app/retirement',
  insights: '#/app/insights',
  connector: '#/app/connector',
  settings: '#/app/settings',
};

export const PAGE_TITLES = {
  overview: 'Overview',
  accounts: 'Accounts',
  transactions: 'Transactions',
  budgets: 'Budgets',
  recurring: 'Recurring',
  goals: 'Goals',
  retirement: 'Retirement',
  insights: 'Insights',
  connector: 'Meridian Connector',
  settings: 'Settings',
};

export const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF', 'INR', 'BRL'];

export const ACCOUNT_TYPES = ['Checking', 'Savings', 'Credit Card', 'Investment', 'Cash', 'Loan', 'Other'];

export const TRANSACTION_TYPES = ['expense', 'income', 'transfer'];

export const BUDGET_PERIODS = ['monthly', 'weekly'];

export const FREQUENCIES = ['Weekly', 'Monthly', 'Quarterly', 'Yearly'];
export const FREQUENCY_FACTOR = { Weekly: 52, Monthly: 12, Quarterly: 4, Yearly: 1 };

/* Retirement accounts are manual records. Values are stored as stable keys;
   labels are rendered in the UI so exports stay compact and predictable. */
export const RETIREMENT_TYPES = [
  { value: '401k', label: '401(k)' },
  { value: '403b', label: '403(b)' },
  { value: 'ira', label: 'IRA' },
  { value: 'roth-ira', label: 'Roth IRA' },
  { value: 'sep-ira', label: 'SEP IRA' },
  { value: 'simple-ira', label: 'SIMPLE IRA' },
  { value: 'pension', label: 'Pension' },
  { value: 'hsa', label: 'HSA' },
  { value: 'profit-sharing', label: 'Profit sharing' },
  { value: 'deferred-comp', label: 'Deferred comp' },
  { value: 'other', label: 'Other' },
];
export const RETIREMENT_STATUSES = [
  { value: 'active', label: 'Active' },
  { value: 'closed', label: 'Closed' },
];

export const CATEGORIES = [
  'Groceries', 'Dining', 'Housing', 'Utilities', 'Transport', 'Health',
  'Entertainment', 'Shopping', 'Travel', 'Education', 'Subscriptions',
  'Income', 'Transfer', 'Other',
];

export const CATEGORY_COLORS = [
  '#3b82f6', '#14b8a6', '#a78bfa', '#f59e0b', '#ec4899',
  '#22c55e', '#38bdf8', '#fb7185', '#eab308', '#6366f1',
  '#2dd4bf', '#f97316', '#94a3b8', '#c084fc', '#84cc16',
];

export const ACCOUNT_COLORS = [
  '#3b82f6', '#14b8a6', '#8b5cf6', '#f59e0b', '#ec4899',
  '#22c55e', '#06b6d4', '#f43f5e', '#eab308', '#64748b',
];

/* Safe deterministic palette for SVG charts and category badges. */
export const CHART_COLORS = [
  '#3b82f6', '#14b8a6', '#8b5cf6', '#f59e0b', '#ec4899',
  '#22c55e', '#38bdf8', '#fb7185', '#eab308', '#6366f1',
];
