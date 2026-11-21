# Tandem Finance

**Shared money, simple.**

Tandem Finance is a static, no-bundler single-page app and a product of Atlas Financial. It keeps the bills you share with other people in one calm place: groups, shared expenses, IOUs, simplified balances and settle-up plans.

> **Important:** Tandem is a **manual** companion for shared money. Every expense and payment is entered by you or a group member. It does **not** store bank credentials, offer bank login, use OAuth or Google sign-in, or perform account aggregation. Real bank connections are not enabled.

## Run locally

No build step or dependency installation is required for development:

```bash
npm run dev
# or
python3 -m http.server 4176
```

Then open <http://localhost:4176>.

## Deploy

```bash
npm run deploy
```

This deploys the directory to `tandem-finance.surge.sh` via [surge.sh](https://surge.sh). `CNAME` contains the custom domain, and `.surgeignore` excludes `node_modules`, `package.json` and `package-lock.json`. The cloud token is stored per browser in `localStorage`; do not commit secrets.

## Pages

- **Landing** — hero, feature grid, honest "no bank login" note, Made by Atlas Financial footer
- **Auth** — sign in / sign up with Cloud/Browser mode toggle
- **Overview** — total outstanding, your net balance, recent activity, group cards, settle-up prompts and deterministic insights
- **Groups** — create/edit/delete groups, add/remove members with colors, group detail with balances and totals
- **Expenses** — add/edit/delete with payer, split method, category, date and note; per-member shares; custom amounts validated against the total
- **Balances** — simplified pairwise net balances from expenses and settlements, who owes whom, greedy settle-up suggestions, record settlements
- **Activity** — chronological feed of expenses and settlements with group/type filters
- **Settings** — theme, currency, sync endpoint, cloud signout, export/import JSON, clear data

## Authentication

Tandem prefers cloud accounts when the configured sync endpoint is reachable; otherwise it falls back to local browser accounts using salted PBKDF2 (SHA-256) via Web Crypto. The active mode is shown on the auth screen, in the topbar and in Settings. There is no OAuth or Google sign-in.

First signup runs a short onboarding that chooses the theme (Cream or Plum), the base currency and a starter group with members.

## Cloud sync API

The base URL is configurable in Settings and stored as `tandem.syncEndpoint` (default `http://localhost:8787`). Snapshots are stored under the `tandem` app key.

- `POST /api/auth/signup {email, name, password} -> {token, user}`
- `POST /api/auth/login {email, password} -> {token, user}`
- `GET /api/me` (Bearer) -> `{user}`
- `GET /api/snapshot/tandem` (Bearer) -> `{app, data, updatedAt}`
- `PUT /api/snapshot/tandem` (Bearer) `{data, clientId}` -> `{ok, updatedAt, clientId}`
- `GET /api/events?token=<token>` — native EventSource, token in query string (no headers), used for live updates
- `GET /api/health`

All non-SSE calls use `Authorization: Bearer <token>`. `EventSource` cannot set headers, so the sync service accepts the token as a query parameter on `/api/events` only. The stream subscription is recreated whenever the token or endpoint changes, and events carrying our own `clientId` are ignored. Local data changes are pushed with a debounced `PUT` snapshot. If the endpoint is unreachable, Tandem falls back to local-only mode with a visible banner.

> The `tandem` app allowlist must be configured in the Atlas Sync service separately. That service is outside this repository.

## Data model

Blank workspace:

```js
{
  settings: {
    currency: 'USD', theme: 'cream', name: '', syncEndpoint: '',
    cloudToken: '', onboardingComplete: false,
  },
  groups: [],      // {id, name, emoji, kind: 'Household'|'Trip'|'Event'|'Other', members:[{id,name,email?,color}], createdAt}
  expenses: [],    // {id, groupId, date, title, amount, payerId, split:'equal'|'shares'|'custom', shares:{}, custom:{}, note, category}
  settlements: [], // {id, groupId, date, fromId, toId, amount, note}
  activity: [],
}
```

Balance math: each expense credits the payer and debits each member's share; each settlement credits the receiver and debits the payer. Net positive means the member is owed; net negative means they owe. The settle-up plan repeatedly pairs the largest debtor with the largest creditor, deterministically.

## Architecture

- ES modules loaded directly in the browser; no bundler, framework or runtime dependencies
- Hash routing: `#/`, `#/signin`, `#/signup`, `#/app/<page>`
- String-rendered views with event delegation via `data-action`
- Local-first cached data in `localStorage`, with cloud snapshot hydration and debounced sync on top
- Dependency-free SVG charts (donut, horizontal bars, monthly columns)
- HTML escaped everywhere; graceful empty states; cream (light) and plum (dark) themes

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
