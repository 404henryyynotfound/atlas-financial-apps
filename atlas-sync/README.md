# atlas-sync

Zero-dependency cloud sync service for the Atlas Financial apps (`meridian-finance`, `airo-finance`, `tandem-finance`, `atlas-business`, the separate `atlas-developers` tool, and the new Atlas Calendar); the corporate `atlas-financial` site links to them all. It powers the Meridian Connector pairing flow, unified account profiles, shared calendar events, and live sync over Server-Sent Events.

Runs on **Node 20+** with no npm install step — only built-in `http`, `crypto`, `fs`, `path`, etc. There is **no Google login, OAuth flow, or real provider API**: accounts are email + password, and pairing codes are generated locally. All calendar writes are manual/local data synced through this service.

## Run

```bash
cd atlas-sync
node server.js
# or: npm start
# development with auto-restart: npm run dev
```

The service listens on `http://localhost:8787` by default and creates `data/store.json` automatically.

### Environment variables

| Variable     | Default            | Description                                                            |
| ------------ | ------------------ | ---------------------------------------------------------------------- |
| `PORT`       | `8787`             | HTTP port to bind (`0` = ephemeral, mainly useful in tests).           |
| `DATA_FILE`  | `data/store.json`  | JSON state file. Relative paths resolve from the `atlas-sync` folder.  |

```bash
PORT=9000 DATA_FILE=/var/lib/atlas-sync/store.json node server.js
```

Run the self-test (starts its own server on an ephemeral port with a temp data file):

```bash
npm test        # or: node test.js
```

## How sync works

1. A user signs up / logs in and receives a bearer token bound to a profile (`personal` by default). One account can hold several profiles (`personal`, `family`, `business`, `developer`); creating one returns a **new token** bound to it.
2. In Meridian (or Airo), `POST /api/connector/code` produces a 6-digit code valid for 10 minutes and usable once. It carries the creating token's profile so redeemed tokens stay on the same profile.
3. In the other app, `POST /api/connector/redeem` exchanges the code for a bearer token for the **same user** — no password needed.
4. Apps `PUT` their local snapshot to `/api/snapshot/meridian`, `/api/snapshot/airo`, `/api/snapshot/tandem`, `/api/snapshot/business` or `/api/snapshot/developer`. Business and developer snapshots require a token bound to the matching profile type (otherwise `403 PROFILE_REQUIRED`).
5. Calendar events are shared: `POST /api/calendar/events` for manual events, `PUT /api/calendar/events/sync` for app-sourced events, and `GET /api/calendar/events` from any app to see the same list. `GET /api/calendar/derived` additionally derives read-only events from stored app snapshots.
6. Each app holds an `GET /api/events` SSE connection. Snapshot writes broadcast a `snapshot` event and calendar writes broadcast a `calendar` event to all of that user's streams; include a `clientId` on snapshot writes so the writer can ignore its own event.

`GET /api/connector/status` tells the UI which apps have stored snapshots (calendar is deliberately not listed there). `DELETE /api/snapshot/:app` resets/unlinks one app.

## API

All responses are JSON except `/api/events` (SSE). Errors look like `{"error":"..."}`; a profile-type violation is HTTP `403` with `{"error":"Forbidden","requiredType":"business","code":"PROFILE_REQUIRED","profiles":[...]}`. CORS allows all origins; `OPTIONS` preflights return `204`.

### Health

```bash
curl http://localhost:8787/api/health
# {"ok":true,"time":"2026-11-21T..."}
```

### Signup

```bash
curl -X POST http://localhost:8787/api/auth/signup \
  -H 'Content-Type: application/json' \
  -d '{"email":"user@example.com","name":"Ada","password":"correct-horse-battery","type":"personal"}'
# {"token":"<64 hex chars>","user":{"id":"uuid","email":"user@example.com","name":"Ada","type":"personal","profile":{...},"profiles":[...]},"profile":{...},"profiles":[...]}
```

`type` is optional and defaults to `personal`; valid values are `personal`, `family`, `business`, `developer`. Signing up creates that profile for the new account and binds the token to it; if the profile already exists it is reused. Email is normalized to lowercase, password must be at least 8 characters, and duplicate emails return `409`. Passwords are stored as salted PBKDF2-SHA256 hashes (150,000 iterations) and never returned to clients.

### Login / current user

```bash
curl -X POST http://localhost:8787/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"user@example.com","password":"correct-horse-battery","type":"business"}'

curl http://localhost:8787/api/me -H 'Authorization: Bearer <TOKEN>'
# {"user":{"id":"...","email":"...","name":"...","type":"business","profile":{...},"profiles":[...]},"profile":{...},"profiles":[...]}
```

Login's `type` is optional: when a profile of that type exists the token is bound to it, otherwise it is bound to the account's first profile. Both responses include every profile so the UI can show a "Create business/developer profile" CTA after a 403. `/api/me` reports the profile the current token is bound to.

### Profiles (unified accounts)

One email/password account owns all profiles. A profile is `{id,userId,type,name,status,createdAt}`; only one profile per `(userId, type)` exists.

```bash
curl http://localhost:8787/api/profiles -H 'Authorization: Bearer <TOKEN>'
# {"profiles":[{...},{...}]}

curl -X POST http://localhost:8787/api/profiles \
  -H 'Authorization: Bearer <TOKEN>' -H 'Content-Type: application/json' \
  -d '{"type":"business","name":"Acme Inc."}'
# {"token":"<NEW TOKEN>","user":{...},"profile":{...},"profiles":[{...},{...}]}
```

`POST /api/profiles` also reuses an existing profile of that type, but always issues a **new token** bound to it — store that token in the app that switched profiles.

Business and developer data endpoints require the token's bound profile to match: `GET/PUT/DELETE /api/snapshot/business` needs `business`, and the same for `developer`. A token bound to `personal` or `family` gets `403 PROFILE_REQUIRED` with the required type and the user's available profiles; the UI should then show the create/switch CTA. Other snapshots (including calendar) accept all profile types.

```bash
# Check ahead of time (Bearer header or ?token= both work)
curl 'http://localhost:8787/api/auth/check?type=business' -H 'Authorization: Bearer <TOKEN>'
# {"allowed":true,"requiredType":"business","profileType":"personal","profiles":[...],"needsSwitch":true}
```

`allowed` means the account owns a profile of that type; `needsSwitch` is true when the current token is bound elsewhere but the profile exists. No password data is ever returned.

### Connector pairing

```bash
# App A (authenticated): create a single-use, 10-minute code
curl -X POST http://localhost:8787/api/connector/code \
  -H 'Authorization: Bearer <TOKEN>'
# {"code":"123456","expiresAt":"2026-11-21T..."}

# App B (no auth): redeem the code for a token for the same user
curl -X POST http://localhost:8787/api/connector/redeem \
  -H 'Content-Type: application/json' \
  -d '{"code":"123456"}'
# {"token":"<TOKEN>","user":{...}}

curl http://localhost:8787/api/connector/status -H 'Authorization: Bearer <TOKEN>'
# {"linked":{"meridian":true,"airo":true,"tandem":false,"business":true,"developer":true},"updatedAt":{"meridian":"...","airo":"...","tandem":null,"business":"...","developer":"..."}}
```

Code creation is limited to 10 per hour per user and per IP; redemption is limited to 10 per hour per IP (in-memory counters, reset on restart). Headers include `Retry-After` when limited.

### Snapshots

`app` must be `meridian`, `airo`, `tandem`, `business` or `developer`. Data may be any JSON value. Business/developer endpoints require a token bound to the matching profile type (see Profiles above); calendar is not a snapshot app.

```bash
curl -X PUT http://localhost:8787/api/snapshot/airo \
  -H 'Authorization: Bearer <TOKEN>' -H 'Content-Type: application/json' \
  -d '{"data":{"accounts":[{"id":"a1","balance":100}]},"clientId":"airo-tab-abc"}'
# {"ok":true,"updatedAt":"2026-11-21T...","clientId":"airo-tab-abc"}

curl http://localhost:8787/api/snapshot/airo -H 'Authorization: Bearer <TOKEN>'
# {"app":"airo","data":{...},"updatedAt":"..."}
# If never stored: {"app":"airo","data":null,"updatedAt":null}

curl -X DELETE http://localhost:8787/api/snapshot/airo -H 'Authorization: Bearer <TOKEN>'
# {"ok":true}
```

### Calendar events

Events are shared across all apps. An event is
`{id,userId,profileId,app,sourceId,title,description,start,end,allDay,location,category,status,createdAt,updatedAt}`;
`sourceId` is `null` for manual events. All calendar routes require a Bearer token and accept any profile type.

```bash
# List (optionally ?from=ISO&to=ISO&type=business); sorted by start
curl 'http://localhost:8787/api/calendar/events?from=2026-11-01T00:00:00Z&to=2026-12-01T00:00:00Z' \
  -H 'Authorization: Bearer <TOKEN>'
# {"events":[{...}]}

# Create a manual event (app defaults to "calendar"; optional type picks another profile)
curl -X POST http://localhost:8787/api/calendar/events \
  -H 'Authorization: Bearer <TOKEN>' -H 'Content-Type: application/json' \
  -d '{"title":"Dentist","start":"2026-11-24T09:00:00Z","end":"2026-11-24T10:00:00Z","allDay":false}'
# 201 {"event":{...}}

# Update / delete (owner only)
curl -X PATCH http://localhost:8787/api/calendar/events/<ID> \
  -H 'Authorization: Bearer <TOKEN>' -H 'Content-Type: application/json' \
  -d '{"title":"Rescheduled"}'
# {"event":{...}}

curl -X DELETE http://localhost:8787/api/calendar/events/<ID> -H 'Authorization: Bearer <TOKEN>'
# {"ok":true}
```

`title` and `start` are required on create; dates are validated with `Date.parse()`. `PATCH` accepts any of the editable fields (plus `type` to rebind the event to another of the user's profiles).

Apps that own a collection of events can replace it idempotently. `sourcePrefix` scopes the replacement; provided events with a `sourceId` get deterministic IDs (`evt_` + first 16 hex chars of `sha256(userId + sourceId)`), so repeating the same sync produces no duplicates.

```bash
curl -X PUT http://localhost:8787/api/calendar/events/sync \
  -H 'Authorization: Bearer <TOKEN>' -H 'Content-Type: application/json' \
  -d '{"app":"airo","sourcePrefix":"airo:bills:","events":[{"sourceId":"airo:bills:42","title":"Rent due","start":"2026-12-01","category":"bills"}]}'
# {"ok":true,"count":1}
```

`app` may be any of the five snapshot apps or `calendar`. The response broadcasts a `calendar` frame with `{action:"refresh",app}` so other apps know to re-fetch.

`GET /api/calendar/derived` returns additional read-only events derived defensively from stored snapshots (never written to the event store): airo `recurring[].nextDate`, `goals[].deadline`, `invoices[].dueDate`; business `payroll[].date|payDate`, `invoices[].dueDate`, `debts[].dueDate`, `employees[].reviewDate`; meridian `goals[].deadline`; tandem `expenses[].date` (25 most recent only); developer `invoices[].dueDate`, `subscriptions[].nextDate`, `payouts[].date`, `goals[].deadline`. Their `sourceId` is `<app>:<collection>:<id>`, and business/developer rows bind to the matching profile type while the rest bind to `personal`. Invalid or missing dates and non-object rows are skipped.

### Live events (SSE)

```bash
curl -N http://localhost:8787/api/events -H 'Authorization: Bearer <TOKEN>'
```

The stream starts with `: connected\n\n`, sends `: ping\n\n` every 20 seconds, and pushes one frame per snapshot or calendar write:

```text
event: snapshot
data: {"app":"airo","updatedAt":"2026-11-21T...","clientId":"airo-tab-abc"}

event: calendar
data: {"action":"create","event":{...}}
```

Calendar actions are `create`, `update`, `delete` (with the affected `event`) and `refresh` (with `app`, asking clients to re-fetch). Snapshot frames keep the exact `event: snapshot` name used by existing apps.

Events are only delivered to SSE connections belonging to the user who wrote the snapshot/event. Native `EventSource` cannot set an `Authorization` header, so `/api/events` also accepts the bearer token as a query parameter: `GET /api/events?token=YOUR_TOKEN`. Use HTTPS in production so the token is not sent in clear text. All other endpoints still require the `Authorization: Bearer` header.

## Storage

State is a single JSON file (`data/store.json`): users, profiles, token records (including their bound `profileId`), hashed pairing codes, per-user/per-app snapshots, and calendar events. Writes are serialized and atomic (temp file in the same directory, then `rename`), so the service is safe to run with one process. The `data/` directory is gitignored.

## Deployment

The service needs a persistent disk for `DATA_FILE`; otherwise accounts and snapshots vanish when the container or host is recycled. It is designed for a **single instance** — rate-limit counters and SSE subscribers are process-local, and two instances writing the same JSON file would conflict. Use a shared database and a pub/sub bus if you need horizontal scaling.

- **Docker** (included):

  ```bash
  docker build -t atlas-sync .
  docker run -p 8787:8787 -v atlas-sync-data:/app/data atlas-sync
  ```

  Override the port with `-e PORT=9000 -p 9000:9000` (rebuild with `--build-arg PORT=9000` if you also want `EXPOSE` to match).

- **Render**: a Web Service with `node server.js` (or `npm start`) and a persistent disk mounted for the data directory; set `DATA_FILE` to a path on that disk. Free-tier disks are not persistent.
- **Railway**: deploy from the folder and add a volume mounted at e.g. `/data`, then set `DATA_FILE=/data/store.json`.
- **Fly.io**: mount a Fly Volume and set `DATA_FILE` to a path on it; use one machine for now.
- **Any Node host**: ship the folder, set `PORT`, ensure the process user can write the data directory, and terminate TLS in front of the service.

Always use HTTPS in production: bearer tokens and pairing codes are otherwise visible in transit. Set `Access-Control-Allow-Origin` more narrowly at your proxy if you do not want every origin to call the API.

## Caveats

- Rate limits are in-memory and per process; they reset on restart and are not shared across instances.
- Pairing codes are stored as salted PBKDF2 hashes, but only 6 digits of entropy exist; the per-IP redemption limit is what makes brute force impractical. Do not expose the redeem endpoint without that limit in a multi-instance deployment.
- Authentication is manual email/password only — no Google/OAuth, no third-party provider APIs, and no secrets are stored or required.
- SSE connections count toward Node's socket limits; the service disconnects streams cleanly on shutdown.
