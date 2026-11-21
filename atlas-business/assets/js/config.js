/* Atlas Business — configuration and brand constants.
   A product of Atlas Financial. No bundler, no runtime dependencies. */
export const BRAND = {
  legal: 'Atlas Financial',
  dba: 'Atlas Business',
  product: 'Atlas Business',
  tagline: 'The whole business, in focus.',
  domain: 'atlas-business.surge.sh',
  year: new Date().getFullYear(),
};

export const STORAGE = {
  users: 'atlasbiz.users.v1',
  session: 'atlasbiz.session.v1',
  dataPrefix: 'atlasbiz.data.v1.',
  syncEndpoint: 'atlasbiz.syncEndpoint',
  clientId: 'atlasbiz.clientId.v1',
  syncMeta: 'atlasbiz.syncMeta.v1',
};

export const DEFAULT_SYNC_ENDPOINT = 'https://atlas-sync.greenhenry441.workers.dev';
export const SYNC_APP = 'business';
export const MERIDIAN_APP = 'meridian';

export const ROUTES = {
  landing: '#/', signin: '#/signin', signup: '#/signup',
  overview: '#/app/overview', employees: '#/app/employees', payroll: '#/app/payroll',
  debts: '#/app/debts', money: '#/app/money', invoices: '#/app/invoices',
  expenses: '#/app/expenses', investments: '#/app/investments', shared: '#/app/shared',
  details: '#/app/details', retirement: '#/app/retirement', insights: '#/app/insights',
  connections: '#/app/connections', settings: '#/app/settings',
};

export const PAGE_TITLES = {
  overview: 'Overview', employees: 'Employees', payroll: 'Payroll', debts: 'Debts',
  money: 'Money', invoices: 'Invoices', expenses: 'Expenses', investments: 'Investments',
  shared: 'Shared money', details: 'Details / Records', retirement: 'Retirement',
  insights: 'Insights', connections: 'Connections', settings: 'Settings',
};

export const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF', 'INR', 'BRL'];
export const THEMES = ['ink', 'paper'];

export const PAY_TYPES = ['salary', 'hourly'];
export const PAY_FREQUENCIES = ['weekly', 'biweekly', 'semimonthly', 'monthly'];
export const PAY_PERIODS = { weekly: 52, biweekly: 26, semimonthly: 24, monthly: 12 };
export const HOURS_PER_PERIOD = { weekly: 40, biweekly: 80, semimonthly: 86.67, monthly: 173.33 };
export const EMPLOYEE_STATUSES = ['active', 'onleave', 'inactive'];
export const PAYROLL_STATUSES = ['draft', 'approved', 'paid'];
export const DEBT_TYPES = ['loan', 'card', 'line', 'vendor'];
export const DEBT_PRIORITIES = ['high', 'medium', 'low'];
export const INVOICE_STATUSES = ['draft', 'sent', 'paid', 'overdue'];
export const EXPENSE_STATUSES = ['pending', 'paid'];
export const DETAIL_TYPES = ['document', 'date', 'contact', 'note'];
export const SPLIT_METHODS = ['equal', 'shares', 'custom'];

/* Retirement plans and employee accounts are manual records. Stable keys are
   stored; readable labels are rendered in the interface. */
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
export const RETIREMENT_PLAN_STATUSES = [
  { value: 'active', label: 'Active' },
  { value: 'frozen', label: 'Frozen' },
  { value: 'closed', label: 'Closed' },
];
export const RETIREMENT_ACCOUNT_STATUSES = [
  { value: 'active', label: 'Active' },
  { value: 'inactive', label: 'Inactive' },
  { value: 'closed', label: 'Closed' },
];

export const ACCOUNT_TYPES = [
  'Operating', 'Payroll', 'Tax', 'Savings', 'Credit Card', 'Cash', 'Loan', 'Investment', 'Other',
];
export const TRANSACTION_TYPES = ['expense', 'income', 'transfer'];
export const BUDGET_PERIODS = ['monthly', 'weekly'];
export const CATEGORIES = [
  'Payroll', 'Rent', 'Utilities', 'Software', 'Marketing', 'Travel', 'Professional',
  'Supplies', 'Insurance', 'Taxes', 'Meals', 'Transport', 'Debt', 'Other', 'Income', 'Transfer',
];
export const EXPENSE_CATEGORIES = CATEGORIES.filter(c => !['Income', 'Transfer'].includes(c));

export const CHART_COLORS = [
  '#28b3a6', '#d9ad63', '#5f8cff', '#a78bfa', '#ef8b6b',
  '#35d39a', '#f2c14e', '#ec82b4', '#7dd3fc', '#94a3b8',
];
export const ACCOUNT_COLORS = [
  '#28b3a6', '#d9ad63', '#5f8cff', '#a78bfa', '#ef8b6b',
  '#35d39a', '#f2c14e', '#ec82b4', '#7dd3fc', '#94a3b8',
];
