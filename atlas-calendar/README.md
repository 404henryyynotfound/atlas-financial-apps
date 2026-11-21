# Atlas Calendar

**Everything in time.**

Atlas Calendar is a static single-page app for one calm view of personal, family, business and developer time. It is a product of Atlas Financial. Events are either entered manually or derived from event snapshots published by other Atlas apps — there are no Google/OAuth sign-ins, no provider APIs and no external assets.

## Run locally

No install step or bundler is required. Serve this directory with any static HTTP server; the included script uses Python:

```sh
npm run dev
```

Open <http://localhost:4188>. ES modules require `http://` (opening `index.html` as a `file://` URL will not work).

## Deploy

The app targets Surge at `atlas-calendar.surge.sh`:

```sh
npm run deploy
```

`CNAME` contains the deployment hostname and `.surgeignore` excludes development files. No repository creation, commit or deployment is performed as part of development.

## Structure

```text
index.html                  Static entry point with inline SVG favicon
CNAME                       Surge hostname
package.json                dev (port 4188) and deploy scripts
.surgeignore                Files excluded from deployment
assets/css/styles.css       Ink/Paper design system, all screens, responsive layout
assets/js/config.js         Brand, routes, type colors, app links, constants
assets/js/utils.js          DOM, escaping, date and formatting helpers
assets/js/store.js          Single-key localStorage state, defaults/normalize/load/save
assets/js/api.js            Atlas Sync request wrapper, auth/events/snapshot/SSE client
assets/js/calendar.js       Event normalization, merge, ranges and view markup
assets/js/charts.js         Dependency-free SVG event-density chart
assets/js/app.js            Controller: routing, auth, views, modals, live updates
```

There are no runtime dependencies, frameworks, build steps, external fonts, external icons or chart libraries.

## Routes

- `#/` — landing page, four type cards, "See how it connects", CTA "Open my calendar"
- `#/signin`, `#/signup` — authentication; signup defaults to Personal and explains all four profiles
- `#/app/overview` — next 7 days, derived deadlines, type counts, event-density chart
- `#/app/month` — seven-column month grid with colored pills and `+N more`
- `#/app/week` — seven columns with timed events on an hour grid and an all-day row
- `#/app/agenda` — events grouped by date with rich rows
- `#/app/settings` — theme, time zone, hidden types, endpoint, snapshots, import/export/clear

Workspace gating uses `?mode=business` or `?mode=developer`. If the active profile does not match, a branded 403 screen offers "Create business/developer profile now" and "Back to my calendar".

## Accounts and profiles

One account works across the Atlas family. The signup form always includes an account-type selector (Personal / Family / Business / Developer) with a description. All state lives in localStorage under `atlasCalendar.state`: token, user, profiles, active profile, settings, cached events and UI preferences.

Switching profiles calls `GET /api/auth/check?type=...`. When the service reports `needsSwitch`, the app asks for the password once, calls `POST /api/auth/login` with the requested `type`, and discards the password immediately. Passwords are never written to localStorage. Creating an extra profile posts to `POST /api/profiles` and adopts the returned token. When the endpoint is unreachable, the app creates a clearly labelled local profile and continues without a token.

## Events

The controller fetches `GET /api/calendar/events?from=&to=&type=` and `GET /api/calendar/derived`, normalizes both feeds, and deduplicates by `sourceId` or `title + start`. Manual events can be created, edited and deleted with a validation-backed modal. Derived events are read-only and link back to the source app:

| App slug | Destination |
| --- | --- |
| `meridian` / `meridian-finance` | `https://meridian-finance.surge.sh` |
| `airo` / `airo-finance` | `https://airo-finance.surge.sh` |
| `tandem` / `tandem-finance` | `https://tandem-finance.surge.sh` |
| `business` / `atlas-business` | `https://atlas-business.surge.sh` |
| `developers` / `atlas-developers` | `https://atlas-developers.surge.sh` |

A source-provided `href`/`url`/`link` is used first when it is an http(s) URL.

## Atlas Sync API

Default endpoint: `http://localhost:8787`. Override it with `?endpoint=https://…` or the Settings field (the URL parameter takes precedence while present). The client uses `request(path, { method, token, body })`, sends the bearer token unless explicitly told not to, and returns `{ ok, status, data, error }` for every call.

Endpoints used:

- `POST /api/auth/signup`, `POST /api/auth/login`, `GET /api/me`
- `GET /api/profiles`, `POST /api/profiles`, `GET /api/auth/check?type=`
- `GET/POST /api/calendar/events`, `PATCH/DELETE /api/calendar/events/:id`
- `GET /api/calendar/derived` (also used by Settings → Refresh derived events)
- `PUT /api/snapshot/calendar` with `{ data, clientId }`
- `GET /api/events?token=` (SSE; listens for `snapshot` and `calendar` frames with exponential-backoff reconnection)

Events may also be pushed into the shared feed by other apps via `PUT /api/calendar/events/sync`; Atlas Calendar only reads that feed. If any request fails with a network error, the app keeps working from its local cache and shows a local-only banner. No console errors are expected when the endpoint is offline.

## Privacy

No password, token-dependent credential cache or provider secret is stored beyond the bearer token required by Atlas Sync. The transient profile-switch password exists only in the submit handler and is cleared from the form as soon as the login request completes. Export includes preferences and locally created events, never a password or token.
