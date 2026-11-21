# Atlas Business

**The whole business, in focus.**

Atlas Business is a static, fourth Atlas Financial product for running an owner-operated business in one workspace: overview, employees, payroll, debts, money, invoices, expenses, investments, shared money, records, insights, connections, and settings.

Atlas Business is a product of Atlas Financial.

## Run locally

No install step or bundler is required. Serve the directory with any static HTTP server; the included script uses Python:

```sh
npm run dev
```

Open <http://localhost:4178>. ES modules require `http://` (opening `index.html` as a `file://` URL will not work).

## Deploy

The app is designed for Surge at `atlas-business.surge.sh`:

```sh
npm run deploy
```

`CNAME` contains the deployment hostname and `.surgeignore` excludes development files. Deploying requires Surge to be available in the environment and authenticated.

## Structure

```text
index.html                  Static entry point
assets/css/styles.css       Ink/Paper design system and all screens
assets/js/config.js         Brand, routes, constants, currencies, palette
assets/js/utils.js          Formatting, date, math, CSV and settle-up helpers
assets/js/store.js          Data model, local accounts, sessions, persistence
assets/js/api.js            Atlas Sync HTTP and EventSource client
assets/js/charts.js         Dependency-free SVG charts
assets/js/app.js            Routing, views, forms, actions, sync engine, boot
```

There are no runtime dependencies, frameworks, build steps, external CSS libraries, or chart libraries.

## Screens and routes

- `#/app/overview` — KPIs, cash-flow view, upcoming items, recent activity
- `#/app/employees` — people, roles, pay setup, status, pay history
- `#/app/payroll` — pay periods, drafts, approvals, paid runs, cost summary
- `#/app/debts` — balances, rates, minimums, payoff projections
- `#/app/money` — accounts, transactions, transfers, budgets
- `#/app/invoices` — invoice status, aging, customer totals
- `#/app/expenses` — out-of-pocket costs and reimbursement status
- `#/app/investments` — holdings, allocation, contribution notes
- `#/app/shared` — participants, bills, shares, and greedy settle-up
- `#/app/details` — documents, dates, contacts, and notes
- `#/app/insights` — deterministic observations from entered data
- `#/app/connections` — Atlas Sync status and Meridian pairing code redemption
- `#/app/settings` — profile, theme, currency, endpoint, data import/export/clear

`#/`, `#/signin`, and `#/signup` provide the landing page and authentication screens.

## Data and accounts

All business information is **manually entered**. Atlas Business does not connect to banks, payroll providers, or tax services, and it does not request bank, payroll-provider, or Google credentials. Bank, payroll, and tax figures shown in the app are labels and amounts supplied by the user.

`store.js` normalizes saved and imported records into the application's `blankData` shape and tolerates missing or older fields. Local accounts are stored in the browser with salted PBKDF2 password derivation; they are not cloud accounts.

The Settings screen supports JSON export/import, CSV export where available, data clearing, theme (`ink` or `paper`), display currency, and sync endpoint configuration.

## Cloud sync

Cloud sync is optional. When available, Atlas Business targets the separate **Atlas Sync** service using app slug `business` and these endpoints:

- `GET /api/health`
- `POST /api/auth/signup`
- `POST /api/auth/login`
- `GET /api/me`
- `GET /api/snapshot/business`
- `PUT /api/snapshot/business`
- `GET /api/events?token=...`
- `POST /api/connector/redeem` for Meridian pairing codes

The default endpoint is `http://localhost:8787` and can be changed in Settings. Snapshot writes include a per-installation `clientId`; live SSE events carrying the same `clientId` are ignored to avoid feedback loops. If `/api/health` or authentication is unavailable, the app shows a clear local-only banner and continues to work from browser storage.

Meridian import is pairing-code redemption only. No Meridian password is requested or stored.

## Calculation notes

- Salary pay is annual; each payroll period receives `annual salary / pay periods`.
- Hourly pay uses fixed configured hours per pay period.
- Annual payroll cost is per-period gross multiplied by periods per year.
- Debt payoff projections apply a fixed minimum payment and monthly interest, capped at 600 months.
- Shared-expense settlement uses greedy matching from largest debtors to largest creditors.
- Insights are deterministic summaries of entered data, not predictions or tax advice.
