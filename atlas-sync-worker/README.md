# Atlas Sync Worker

Cloudflare Workers Free deployment of the Atlas Sync API. No credit card, persistent SQLite storage, native SSE, and Web APIs only at runtime (wrangler is a dev dependency).

Public endpoint: **https://atlas-sync.greenhenry441.workers.dev**

## Why Cloudflare Free

Deno Deploy is shutting down, Render's free disk is ephemeral, and Railway/Fly are not reliably free. Cloudflare's free Workers plan includes a SQLite-backed Durable Object, which gives us durable state and long-lived SSE streams in one place.

## Setup

```bash
cd atlas-sync-worker
npm install
npx wrangler login          # one-time free Cloudflare login (no credit card)
npm run deploy              # npx wrangler deploy
```

All Atlas app defaults already use the public endpoint above. For your own copy, set the sync URL in each app's **Settings / Connector** page. Existing apps keep using `GET /api/events?token=<token>` (native EventSource) and `Authorization: Bearer <token>` everywhere else.

Optional but recommended — pepper the one-time pairing-code digests:

```bash
npx wrangler secret put CODE_PEPPER
```

Without a pepper, codes are stored as plain SHA-256 digests; a 6-digit code is brute-forceable from a leaked database. With a pepper, the digest is `HMAC-SHA256(CODE_PEPPER, code)`. Never commit the pepper or `.dev.vars`.

Local development: `npm run dev`. Validation: `npm test` (static checks + in-process Worker smoke test; no Cloudflare credentials needed).

## API contract (unchanged routes)

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `GET /api/health` | none | `{ok,time,service}` |
| `POST /api/auth/signup` | none | create account + default profile, returns token/user/profile/profiles |
| `POST /api/auth/login` | none | optional `type`; binds token to that profile when it exists |
| `GET /api/me` | Bearer | `{user,profile,profiles}`; `user.type` kept for compatibility |
| `POST /api/connector/code` | Bearer | 6-digit code, 10-minute expiry, single use, hashed at rest |
| `POST /api/connector/redeem` | none | exchange code for a fresh token |
| `GET /api/connector/status` | Bearer | linked flags + timestamps for all five apps |
| `GET /api/events` | Bearer or `?token=` | SSE stream (`: connected`, `: ping` every 20s) |
| `GET/PUT/DELETE /api/snapshot/:app` | Bearer | per-user, per-app snapshots |

`OPTIONS` returns 204 and all responses allow any origin. Passwords are salted PBKDF2-SHA256 (100,000 iterations, the Cloudflare Workers WebCrypto limit) and never returned. Code creation is limited to 10/hour per user **and** per IP; redemption to 10/hour per IP.

## Unified accounts and profiles

One account owns any of four profiles: `personal`, `family`, `business`, `developer`. Signup creates `personal` by default; pass `type` to choose another. Login with `type` binds the new token to that profile when it exists, otherwise to the first profile (the full `profiles` list is always returned).

- `GET /api/profiles` → `{profiles, profile}`
- `POST /api/profiles` with `{type,name?}` → creates another profile and returns a **new token** bound to it
- `GET /api/auth/check?type=business` → `{allowed,requiredType,profileType,profiles}`. Auth is optional (Bearer or `?token=`). `allowed:false` is always HTTP 200 so the UI can render a branded 403 screen.

Business and developer data endpoints reject personal/family tokens with HTTP 403:

```json
{ "error": "forbidden", "requiredType": "business", "code": "PROFILE_REQUIRED" }
```

Recommended client flow: call `/api/auth/check?type=business` after login; if `allowed` is false, show a **"Create business profile"** CTA that posts to `/api/profiles`, stores the returned token, and retries. The guard is enforced server-side on `/api/snapshot/business`, `/api/snapshot/developer`, and `/api/calendar/events/sync` for those apps.

## Calendar API

- `GET /api/calendar/events?from=&to=&type=` → `{events}`; includes manual + app-derived events for the whole account, optionally filtered by profile type.
- `POST /api/calendar/events` → create a manual event (`title`, `start`, `end?`, `allDay?`, `description?`, `location?`, `category?`, `type?`, `app?`).
- `PATCH /api/calendar/events/:id`, `DELETE /api/calendar/events/:id` → owner-only mutations.
- `PUT /api/calendar/events/sync` → `{app,sourcePrefix,events:[{sourceId,title,start,end?,allDay?,...}]}` replaces only that prefix's derived events for the user (idempotent).
- `GET /api/calendar/derived` → flat array derived defensively from stored snapshots: airo bills/goals/invoices, business payroll/invoices/debts/reviews, meridian goals, developer invoices/subscriptions/payouts/goals, and optional tandem expenses.

Calendar mutations broadcast an SSE frame on the existing stream:

```
event: calendar
data: {"action":"upsert","event":{...}}

```

`action` is `upsert`, `delete`, or `refresh` (with `app`). Snapshot frames remain exactly `event: snapshot\ndata: {...}\n\n`.

## Architecture and caveats

Every `/api/*` request is routed to a **single** Durable Object named `atlas-sync-global`. SQLite tables: `users`, `profiles`, `tokens` (with `profile_id`), `connector_codes`, `snapshots`, `calendar_events`. Schema is created idempotently on first request, so no v2 migration tag is needed; legacy `tokens` rows with NULL `profile_id` are treated as the user's first profile and lazily bound.

Tradeoffs to know:

- One global object is simple and generous for this app family, but it serializes writes and has a soft limit around 1,000 requests/second. Per-user objects would scale further at the cost of token lookup in the Worker.
- SSE subscriber streams and rate-limit counters live in that object's memory. Streams are dropped on an object restart (EventSource reconnects natively); rate limits are per object, not globally shared across multiple Workers.
- Workers Free limits (per account, reset 00:00 UTC): 100,000 Worker requests/day, 100,000 DO requests/day, 5M SQLite rows read/day, 100,000 rows written/day, 5 GB stored data. Past a limit, calls fail until reset — never billed.
- No Google/OAuth, no secrets in source, no Node APIs at runtime.

`schema.sql` is a readable reference for the tables the worker creates.
