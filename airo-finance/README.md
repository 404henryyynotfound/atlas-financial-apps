# Airo Finance

**Money, made clear.**

Airo Finance is a static, no-bundler single-page finance workspace and a product of Atlas Financial. It provides budgets, manual accounts, transactions, recurring items, goals, deterministic insights, optional cloud sync, and a Meridian Connector.

> **Important:** Airo uses **manual account records only**. It does not store bank credentials, offer bank login, or perform account aggregation. Real bank login and aggregation are not enabled.

## Run locally

No build step or dependency installation is required for development:

```bash
npm run dev
# or
python3 -m http.server 4174
```

Then open <http://localhost:4174>.

## Deploy

```bash
npm run deploy
```

This deploys the directory to `airo-finance.surge.sh` via [surge.sh](https://surge.sh). `CNAME` contains the custom domain, and `.surgeignore` excludes `node_modules`, `package.json`, and `package-lock.json`. Do not commit secrets; the cloud token is stored per browser in `localStorage`.

## Pages

- **Overview** — net worth, cashflow, spend donut, recent transactions, budget progress, Meridian card
- **Accounts** — add/edit/archive manual accounts and totals by type
- **Transactions** — add/edit/delete, filters, income/expense/transfer, running balance
- **Budgets** — create/edit/delete monthly or weekly category limits with progress
- **Recurring** — next dates and annualized costs
- **Goals** — targets, deadlines and contribution tracking
- **Insights** — deterministic calculations over local data
- **Meridian Connector** — 6-digit link code, endpoint, imported holdings/watchlist/goals, sync status
- **Settings** — theme, currency, endpoint, signout, export/import/clear data

## Authentication

Airo prefers cloud accounts when the configured sync endpoint is reachable. Otherwise it falls back to local browser accounts using salted PBKDF2 (SHA-256) via Web Crypto. The active mode is shown in the auth screen, topbar and settings. There is no Google/OAuth sign-in.

- Cloud signup/login: `POST /api/auth/signup`, `POST /api/auth/login`
- Identity: `GET /api/me`
- Snapshots: `GET`/`PUT /api/snapshot/:app`
- Events: `GET /api/events`
- Health: `GET /api/health`
- Meridian codes: `POST /api/connector/code`, `POST /api/connector/redeem`

All non-SSE calls use `Authorization: Bearer <token>`. Live updates use native `EventSource`, which cannot set headers, so the sync service accepts the token as a query parameter on `/api/events` only:

```text
GET /api/events?token=<url-encoded-token>
```

The `EventSource` is recreated whenever the token or endpoint changes.

## Data model

Blank workspace:

```js
{
  settings: {
    currency: 'USD', theme: 'light', name: '', syncEndpoint: '',
    cloudToken: '', linkedMeridian: false, onboardingComplete: false,
  },
  accounts: [], transactions: [], budgets: [], recurring: [], goals: [],
  meridian: null,
}
```

## Architecture

- ES modules loaded directly in the browser; no bundler, framework or runtime dependencies
- Hash routing: `#/`, `#/signin`, `#/signup`, `#/app/<page>`
- String-rendered views with event delegation via `data-action`
- Local-first cached data in `localStorage`, with cloud snapshot hydration and debounced sync on top
- Dependency-free SVG charts (line, donut, bars)
- HTML escaped everywhere; graceful empty states; dark and polished light themes

## Files

```text
index.html
assets/css/styles.css
assets/js/config.js
assets/js/utils.js
assets/js/store.js
assets/js/api.js
assets/js/charts.js
assets/js/app.js
package.json
.surgeignore
CNAME
README.md
```
