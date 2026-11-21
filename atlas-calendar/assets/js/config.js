/* Atlas Calendar — configuration and brand constants.
   A product of Atlas Financial. No bundler, no runtime dependencies. */

export const BRAND = {
  legal: 'Atlas Financial',
  dba: 'Atlas Calendar',
  product: 'Atlas Calendar',
  tagline: 'Everything in time.',
  domain: 'atlas-calendar.surge.sh',
  year: new Date().getFullYear(),
};

/* All persistent state lives under this single namespaced localStorage key. */
export const STORAGE = { key: 'atlasCalendar.state' };

export const DEFAULT_ENDPOINT = 'https://atlas-sync.greenhenry441.workers.dev';
export const SYNC_APP = 'calendar';

export const ROUTES = {
  landing: '#/', signin: '#/signin', signup: '#/signup',
  overview: '#/app/overview', month: '#/app/month', week: '#/app/week',
  agenda: '#/app/agenda', settings: '#/app/settings',
};

export const APP_ROUTES = ['overview', 'month', 'week', 'agenda', 'settings'];
export const PAGE_TITLES = {
  overview: 'Overview', month: 'Month', week: 'Week', agenda: 'Agenda', settings: 'Settings',
};

/* The four type colors are part of the Atlas Calendar identity. */
export const TYPES = [
  { id: 'personal', label: 'Personal', color: 'teal', description: 'Your own plans, appointments and rituals.' },
  { id: 'family', label: 'Family', color: 'coral', description: 'Shared schedules, school runs and home.' },
  { id: 'business', label: 'Business', color: 'violet', description: 'Client work, meetings and deadlines.' },
  { id: 'developer', label: 'Developer', color: 'cyan', description: 'Sprints, releases and shipping windows.' },
];

export const TYPE_IDS = TYPES.map(t => t.id);
export const TYPE_MAP = Object.fromEntries(TYPES.map(t => [t.id, t]));
export const FILTERS = [{ id: 'all', label: 'All' }, ...TYPES];

export const THEMES = ['ink', 'paper'];
export const CATEGORIES = [
  'General', 'Work', 'Health', 'Travel', 'Finance', 'Family',
  'Learning', 'Social', 'Deadline', 'Reminder', 'Other',
];

/* Where derived events can be opened. Only keys and https URLs are ever rendered. */
export const APP_LINKS = {
  calendar: 'https://atlas-calendar.surge.sh',
  meridian: 'https://meridian-finance.surge.sh',
  'meridian-finance': 'https://meridian-finance.surge.sh',
  airo: 'https://airo-finance.surge.sh',
  'airo-finance': 'https://airo-finance.surge.sh',
  tandem: 'https://tandem-finance.surge.sh',
  'tandem-finance': 'https://tandem-finance.surge.sh',
  business: 'https://atlas-business.surge.sh',
  'atlas-business': 'https://atlas-business.surge.sh',
  developers: 'https://atlas-developers.surge.sh',
  'atlas-developers': 'https://atlas-developers.surge.sh',
};

export const APP_LABELS = {
  calendar: 'Atlas Calendar',
  meridian: 'Meridian Finance', 'meridian-finance': 'Meridian Finance',
  airo: 'Airo Finance', 'airo-finance': 'Airo Finance',
  tandem: 'Tandem Finance', 'tandem-finance': 'Tandem Finance',
  business: 'Atlas Business', 'atlas-business': 'Atlas Business',
  developers: 'Atlas Developers', 'atlas-developers': 'Atlas Developers',
};

export const CONNECT_SOURCES = [
  { slug: 'meridian-finance', name: 'Meridian Finance', note: 'Investment checkpoints and market dates' },
  { slug: 'airo-finance', name: 'Airo Finance', note: 'Bills, budgets and money milestones' },
  { slug: 'tandem-finance', name: 'Tandem Finance', note: 'Shared plans and household dates' },
  { slug: 'atlas-business', name: 'Atlas Business', note: 'Payroll, invoices and business deadlines' },
  { slug: 'atlas-developers', name: 'Atlas Developers', note: 'Sprints, releases and project work' },
];

export const TIMEZONES = [
  'auto', 'UTC', 'America/New_York', 'America/Chicago', 'America/Denver',
  'America/Los_Angeles', 'Europe/London', 'Europe/Berlin', 'Asia/Tokyo', 'Australia/Sydney',
];

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const WEEKDAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const HOURS = Array.from({ length: 18 }, (_, i) => i + 6); // 06:00 – 23:00
export const HOUR_HEIGHT = 64;

export const CHART_COLORS = {
  personal: '#3bc7b5', family: '#f08f78', business: '#a78bfa', developer: '#62d5f2',
};
