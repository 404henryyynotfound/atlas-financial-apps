# Atlas Financial apps

Public monorepo for the Atlas Financial product family.

**GitHub:** https://github.com/404henryyynotfound/atlas-financial-apps

| App | Directory | Live site |
| --- | --- | --- |
| Meridian Finance | `meridian-finance/` | https://meridian-finance.surge.sh |
| Atlas Financial corporate site | `atlas-financial/` | https://atlas-financial.surge.sh |
| Airo Finance | `airo-finance/` | https://airo-finance.surge.sh |
| Tandem | `tandem-finance/` | https://tandem-finance.surge.sh |
| Atlas Business | `atlas-business/` | https://atlas-business.surge.sh |
| Atlas Calendar | `atlas-calendar/` | https://atlas-calendar.surge.sh |
| Atlas Developers | `atlas-developers/` — separate public repo | https://atlas-developers.surge.sh |
| Atlas Suite | `atlas-developers/atlas-suite/` — desktop GUI | Snap `atlas-suite` / Flatpak `com.atlasfinancial.Suite` |
| Atlas Sync service | `atlas-sync/` | Deploy to any Node host |
| Swift browser | `swift-browser/` — desktop GUI + landing page | https://swift-browser.surge.sh · Snap `swift-browser` · Flatpak `com.swiftbrowser.Swift` |
| Swift Technologies | `swift-tech/` — editions and platform site | https://swift-tech.surge.sh |
| SwiftShell | `swift-shell/` — shell language, CLI and docs site | https://swift-shell.surge.sh · npm `swift-shell` · Snap `swift-shell` · `.deb` releases |
| cinnamon | `cinnamon/` — computer task manager with live processes, graphs and AI diagnostics | https://cinnamon-tasks.surge.sh · npm `cinnamon-gui` · Snap `cinnamon-tasks` · `.deb` releases |

SwiftShell and cinnamon are standalone products in their own public repos (https://github.com/404henryyynotfound/swift-shell and https://github.com/404henryyynotfound/cinnamon), unrelated to Swift browser or Swift Technologies. Their source directories are kept here for convenience but are ignored by this monorepo.

All browser apps are static, no-bundler ES-module SPAs. They can be opened with any static file server and deployed directly to Surge.

## What's included

### Meridian Finance
Investing workspace: portfolio tracking, watchlists, goals, market discovery, news, local PBKDF2 accounts, on-device Meridian AI, and the **Meridian Connector** pairing code generator.

### Airo Finance
Personal money workspace: manual bank accounts, transactions, budgets, recurring bills, goals, **retirement accounts** (401(k), IRA, HSA and more), insights, local or cloud signin/signup, light/dark themes, and the **Meridian Connector** pairing flow.

### Tandem
Shared-money workspace: groups, members, manual expenses, equal/share/custom splits, simplified balances, settle-up suggestions, activity feed, deterministic insights, local or cloud signin/signup, and polished Cream/Plum themes.

### Atlas Business
The flagship all-in-one workspace: employees, payroll runs, debts and payoff projections, accounts/transactions/budgets, invoices, expenses, **company retirement plans and employee accounts**, investment snapshots, shared expenses, company records, deterministic insights, local or cloud signin/signup, and Ink/Paper themes.

### Atlas Calendar
One account, four workspace types (`personal`, `family`, `business`, `developer`), manual events, month/week/agenda views, and read-only derived deadlines from the other Atlas apps. Business/developer modes show a branded 403 screen with a one-click CTA to create the matching profile under the same account. Live `calendar` SSE frames refresh open calendars. Meridian, Airo, Tandem, Atlas Business and Atlas Developers also carry a compact in-app Calendar widget that reads the same derived endpoint and refreshes over SSE.

### Atlas Developers (separate repo)
Developer-tools product with a payments/invoices dashboard, a zero-dependency CLI, an AI insights engine, an in-app Calendar widget, and downloadable GUI builds for Linux/macOS/Windows on x64 and arm64. Repo: https://github.com/404henryyynotfound/atlas-developers. Published npm packages and sudo system packages are documented below.

### Atlas Suite

A single desktop GUI that bundles local copies of Meridian, Airo, Tandem, Atlas
Business, Atlas Calendar and Atlas Developers. A sidebar switches apps without
opening six tabs, and one Atlas Sync sign-in shares the appropriate profile
token with each bundled app. Packaged as the strict `atlas-suite` snap for
Ubuntu App Center and as a single-file Flatpak (`com.atlasfinancial.Suite`) for
Flathub submission. Source and release automation live in the Atlas Developers
repo under `atlas-suite/`.

```bash
# Ubuntu / App Center
sudo snap install atlas-suite

# Flatpak bundle (before Flathub)
flatpak remote-add --if-not-exists flathub https://flathub.org/repo/flathub.flatpakrepo
flatpak install --user atlas-suite.flatpak
flatpak run com.atlasfinancial.Suite
```

### Atlas Sync
Zero-dependency Node service providing cloud accounts, one-time connector codes, per-app snapshots, real-time SSE updates, and CORS. Meridian pushes portfolio snapshots; Airo redeems the pairing code and keeps its own data synced live; Tandem syncs group data under `tandem`; Atlas Business syncs its full workspace under `business`; Atlas Developers syncs under `developer`.

#### Free hosted sync (Cloudflare Workers)

`atlas-sync-worker/` deploys the same API to Cloudflare's free Workers plan with a SQLite-backed Durable Object (no credit card, persistent state, SSE). It is **live** at https://atlas-sync.greenhenry441.workers.dev, and all app defaults point there. Run `npm run dev:sync-worker` locally and `npm run deploy:sync-worker` to publish your own copy. It adds one account with `personal`/`family`/`business`/`developer` profiles (business/developer endpoints return `403 PROFILE_REQUIRED` until that profile is created via `/api/profiles`, so the UI can show a CTA) plus a shared calendar API under `/api/calendar/*`. Bearer tokens and `GET /api/events?token=` still work. See `atlas-sync-worker/README.md` for setup, limits and caveats.

### Swift browser

A privacy-first desktop browser built on Electron/Chromium. Swift ships a bundled third-party tracker list (no remote download), fingerprint defenses, HTTPS upgrading, Global Privacy Control, third-party cookie blocking, Turbo mode and background tab sleeping. History, bookmarks and settings stay local, with a built-in privacy dashboard and private tabs.

Swift also opens a local-first app suite directly from the browser sidebar: Swift ID, Chat, Meet, AI, Docs, Sheets, Decks, Notes, Calendar, Drive and Tasks. Swift ID is a device-local PBKDF2 account with custom signup/signin screens; Drive files are encrypted with AES-256-GCM. Swift Mail is coming soon and needs a custom domain before `@swift.email` addresses can be created.

```bash
npm run dev:swift                       # start the browser
npm --prefix swift-browser run dist:linux-arm64
npm run deploy:swift                    # publish swift-browser/site to Surge
```

One codebase ships five editions: Swift Lite (low-resource), Swift Enterprise (policy-managed), Swift Beta (public preview), Swift Nightly / Canary (bleeding edge) and Swift Developer (DevTools and automation). Each has its own profile, icon, defaults and release config; see `swift-browser/EDITIONS.md`.

The corporate/product site for the platform is `swift-tech/` and is live at https://swift-tech.surge.sh. It documents all editions, the local-first suite, enterprise and developer channels, and the planned Swift Mail domain.

Snap (`swift-browser`) and Flatpak/Flathub (`com.swiftbrowser.Swift`) packaging lives under `swift-browser/snap/` and `swift-browser/flatpak/`. Full build and submission steps are in `swift-browser/README.md`.

### SwiftShell

A new, independent shell language with variables, arrays, functions, loops, conditionals, pipelines, redirection and command substitution. Every command starts with `swift`; `swiftshell` remains available as an alias. It includes a curated offline package registry (`swift install hello`, `swift registry`, `swift search`) and a static documentation site deployed to Surge.

```bash
npm install -g swift-shell                 # npm (provides swift and swiftshell)
sudo snap install swift-shell              # Snap Store
sudo apt install ./swift-shell_1.0.0_amd64.deb   # .deb from GitHub releases

swift eval 'for x in range(3) { echo "hi $x" }'
swift run script.shs
swift commands                             # list every subcommand
```

Language guide, examples and build commands: `swift-shell/README.md`. Site source: `swift-shell/site/`; deploy with `npm run deploy:swift-shell`.

### cinnamon

A computer task manager: live processes with CPU/memory usage in a sortable flat or parent/child tree table. Pause, resume, interrupt, terminate, kill and renice processes with confirmation, inspect open files, pin processes to follow them, and export CSV or Markdown reports. It also has real-time SVG performance graphs (CPU, memory, disk, network), explainable offline AI diagnostics, optional bring-your-own-key cloud AI, watcher rules and in-app plus GitHub changelogs. Local-first; no account is required.

```bash
npm install -g cinnamon-gui                # npm launcher
sudo snap install cinnamon-tasks           # Snap Store
sudo apt install ./cinnamon-linux-x64.deb        # .deb from GitHub releases
```

Features, BYOK setup and development commands: `cinnamon/README.md`.

Both projects ship [Pi-Apps](https://pi-apps.io/) definitions in `swift-shell/pi-apps/` and `cinnamon/pi-apps/`. The import zips are attached to each GitHub release, and [Pi-Apps PR #3085](https://github.com/Botspot/pi-apps/pull/3085) adds both apps to the official catalogue.

## Shared calendar widgets

Meridian, Airo, Tandem, Atlas Business and Atlas Developers each ship a small ES-module Calendar widget (`assets/js/calendar-widget.js`). It adds a bottom-right launcher, fetches `GET /api/calendar/derived` with the current Atlas Sync bearer token, renders dated events with their source-app badge, and refreshes on `calendar` SSE frames. If no sync token is present it shows a friendly sign-in prompt linking to Atlas Calendar. No credentials or endpoints are hardcoded.

## Install Atlas Developers

Public repo: https://github.com/404henryyynotfound/atlas-developers · Releases: https://github.com/404henryyynotfound/atlas-developers/releases/latest · Site: https://atlas-developers.surge.sh

### npm packages

All three packages are published to npm at **1.0.4**:

| Package | Contents |
| --- | --- |
| `atlas-developers-core` | Shared model, atomic JSON store, deterministic insights and local AI engine |
| `atlas-developers-cli` | The `atlas` command, depends on `atlas-developers-core` |
| `atlas-developers-gui` | `atlas-gui` launcher that downloads, verifies, caches and starts the matching release build |

```bash
npm install -g atlas-developers-cli atlas-developers-gui
atlas --version          # atlas 1.0.4
atlas-gui --dry-run      # show the selected release asset
```

The `NPM_TOKEN` secret is configured in the public repo, so tagged releases publish these packages automatically.

### sudo system packages (CLI and GUI)

Tagged releases include JS-only CLI packages that install `atlas` system-wide:

```bash
VERSION=1.0.4
ARCH=amd64 # or arm64
BASE=https://github.com/404henryyynotfound/atlas-developers/releases/download/v${VERSION}

# Linux (DEB)
curl -fsSLO "${BASE}/atlas-developers-cli_${VERSION}_${ARCH}.deb"
curl -fsSLO "${BASE}/atlas-developers-cli_${VERSION}_${ARCH}.deb.sha256"
sha256sum -c "atlas-developers-cli_${VERSION}_${ARCH}.deb.sha256"
sudo apt install "./atlas-developers-cli_${VERSION}_${ARCH}.deb"

# macOS (PKG, Intel and Apple Silicon)
curl -fsSLO "${BASE}/atlas-developers-cli-${VERSION}.pkg"
sudo installer -pkg "atlas-developers-cli-${VERSION}.pkg" -target /

atlas --version
```

GUI sudo installers use the same release: `atlas-gui-linux-<arch>.deb` and `atlas-gui-macos-<arch>.pkg`. Windows ships an NSIS `.exe` (Run as administrator) plus a portable `.zip`. Every asset has a `.sha256` companion. Ubuntu users can install the strict snap with `sudo snap install atlas-developers` once published, or sideload `atlas-developers_1.0.4_<arch>.snap` from the same release.

## Running locally

```bash
# Terminal 1 — cloud sync + connector service
npm run sync

# Terminal 2 — Meridian
npm run dev:meridian

# Terminal 3 — Airo
npm run dev:airo

# Terminal 4 — Tandem
npm run dev:tandem

# Terminal 5 — Atlas Business
npm run dev:business

# Terminal 6 — Atlas Calendar
npm run dev:calendar
```

Default endpoints:
- Meridian: http://localhost:4173
- Airo: http://localhost:4174
- Tandem: http://localhost:4176
- Atlas Business: http://localhost:4178
- Atlas Calendar: http://localhost:4188
- Atlas Sync: http://localhost:8787 (local dev) / https://atlas-sync.greenhenry441.workers.dev (production)

Configure the sync URL inside each app's Settings/Connector page if the backend runs elsewhere.

## Deploying

```bash
npm run deploy:meridian
npm run deploy:atlas
npm run deploy:airo
npm run deploy:tandem
npm run deploy:business
npm run deploy:calendar
npm run deploy:swift-shell
npm run deploy:cinnamon
```

The static apps need no build step. The sync service needs a Node host with a persistent volume for `atlas-sync/data/store.json` (Render, Railway, Fly.io, a VPS, etc.). After deploying it, set the sync URL in each app to the public HTTPS endpoint.

> No market-data credentials are bundled. Meridian reads an optional Alpha Vantage key from `window.ATLAS_CONFIG.alphaVantageKey` (or from Settings, where it is stored locally). Without a key it falls back to cached/sample data. If a key was ever committed previously, rotate it at Alpha Vantage before publishing.

## GitHub setup

The public repo is at https://github.com/404henryyynotfound/atlas-financial-apps with `origin` configured.

```bash
git add .
git commit -m "Add Tandem, Atlas Business and expanded Atlas site"
git push -u origin main
```

Once your Atlas Financial organization exists, transfer the repo from GitHub settings or create the org repo and replace `origin`:

```bash
git remote set-url origin https://github.com/YOUR_ORG/atlas-financial-apps.git
git push -u origin main
```

## Live cloud sync caveats

- The connector links cloud identities, not real bank logins. Manual accounts in Airo and Atlas Business do not use Plaid or any bank aggregator.
- A one-time 6-digit code from Meridian can be redeemed in Airo or Atlas Business; it expires after 10 minutes and can only be used once.
- Atlas Business payroll, tax and invoice data are manually entered. No payroll provider or tax API is connected.
- If no sync server is configured/reachable, every app continues to work in local-only mode with its local in-browser accounts.
