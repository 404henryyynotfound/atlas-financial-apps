/* Tandem Finance — configuration and brand constants.
   A product of Atlas Financial. No bundler, no runtime dependencies. */
export const BRAND = {
  legal: 'Atlas Financial',
  dba: 'Tandem Finance',
  product: 'Tandem',
  tagline: 'Shared money, simple.',
  domain: 'tandem-finance.surge.sh',
  year: new Date().getFullYear(),
};

export const STORAGE = {
  users: 'tandem.users.v1',
  session: 'tandem.session.v1',
  dataPrefix: 'tandem.data.v1.',
  prefs: 'tandem.prefs.v1',
  clientId: 'tandem.clientId.v1',
  syncEndpoint: 'tandem.syncEndpoint',
  syncMeta: 'tandem.syncMeta.v1',
};

export const DEFAULT_SYNC_ENDPOINT = 'https://atlas-sync.greenhenry441.workers.dev';
export const SYNC_APP = 'tandem';

export const ROUTES = {
  landing: '#/',
  signin: '#/signin',
  signup: '#/signup',
  overview: '#/app/overview',
  groups: '#/app/groups',
  expenses: '#/app/expenses',
  balances: '#/app/balances',
  activity: '#/app/activity',
  settings: '#/app/settings',
};

export const PAGE_TITLES = {
  overview: 'Overview',
  groups: 'Groups',
  expenses: 'Expenses',
  balances: 'Balances',
  activity: 'Activity',
  settings: 'Settings',
};

export const PAGE_SUBTITLES = {
  overview: BRAND.tagline,
  groups: 'Households, trips and events — all in one place.',
  expenses: 'Who paid, who owes, and exactly how it splits.',
  balances: 'Simplified debts and the shortest way to settle up.',
  activity: 'A chronological record of every shared payment.',
  settings: 'Preferences, sync, data and account controls.',
};

export const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF', 'INR', 'BRL'];

export const GROUP_KINDS = ['Household', 'Trip', 'Event', 'Other'];
export const GROUP_EMOJIS = ['🏠', '🧳', '🎉', '🍽️', '🎟️', '🚗', '🏕️', '🎁', '👨‍👩‍👧', '💳'];

export const SPLIT_METHODS = ['equal', 'shares', 'custom'];

export const EXPENSE_CATEGORIES = [
  'Groceries', 'Dining', 'Housing', 'Utilities', 'Transport', 'Travel',
  'Entertainment', 'Shopping', 'Health', 'Activities', 'Gifts', 'Other',
];

/* Warm, friendly chart palette; deterministic by string key. */
export const CATEGORY_COLORS = [
  '#e9685a', '#e8a33d', '#f2c14e', '#d9789f', '#8f6fd3',
  '#48a9a0', '#7cae6a', '#db8a52', '#c46d86', '#5b8fb9',
];

export const MEMBER_COLORS = [
  '#e9685a', '#e8a33d', '#48a9a0', '#8f6fd3', '#d9789f',
  '#7cae6a', '#5b8fb9', '#db8a52', '#c46d86', '#a58bc4',
];

export const CHART_COLORS = CATEGORY_COLORS.slice();
