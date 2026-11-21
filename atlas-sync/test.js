/**
 * Self-test for atlas-sync. Uses only Node built-ins.
 *
 * Starts the real HTTP server on an ephemeral port with a temporary data file,
 * exercises signup/login, unified profiles, the connector pairing flow,
 * snapshots, shared calendar events, derived events, SSE delivery, rate
 * limiting, and persistence across a restart. Exits nonzero on failure.
 *
 *   node test.js
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from './server.js';

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-sync-self-test-'));
const dataFile = path.join(tmpDir, 'store.json');

let instance = null;
let events = null;

function step(message) {
  console.log(`  ✓ ${message}`);
}

function request(route, { method = 'GET', token, body, headers = {} } = {}) {
  const allHeaders = { ...headers };
  if (token) allHeaders.Authorization = `Bearer ${token}`;
  if (body !== undefined) allHeaders['Content-Type'] = 'application/json';
  return fetch(`http://127.0.0.1:${instance.port}${route}`, {
    method,
    headers: allHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Skip unrelated frames (comments, snapshot writes) until a named event. */
async function nextNamedFrame(stream, name) {
  for (let i = 0; i < 20; i += 1) {
    const frame = await stream.nextFrame();
    if (frame.includes(`event: ${name}`)) return frame;
  }
  throw new Error(`Timed out waiting for SSE event: ${name}`);
}

function frameData(frame) {
  const line = frame.split('\n').find((part) => part.startsWith('data: '));
  assert.ok(line, 'SSE frame has a data line');
  return JSON.parse(line.slice(6));
}

async function jsonResponse(res, expectedStatus) {
  const text = await res.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Expected JSON but received: ${text.slice(0, 300)}`);
  }
  assert.equal(
    res.status,
    expectedStatus,
    `expected HTTP ${expectedStatus}, got ${res.status}: ${text.slice(0, 300)}`,
  );
  return payload;
}

/** Minimal SSE reader: yields one blank-line-delimited frame at a time. */
function openEventStream(token) {
  const controller = new AbortController();
  const readerPromise = fetch(`http://127.0.0.1:${instance.port}/api/events`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: controller.signal,
  });

  const state = {
    reader: null,
    decoder: new TextDecoder(),
    buffer: '',
    closed: false,
  };

  async function readWithTimeout(timeoutMs) {
    let timer;
    try {
      return await Promise.race([
        state.reader.read(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Timed out waiting for SSE frame')), timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async ready() {
      const res = await readerPromise;
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') || '', /text\/event-stream/);
      state.reader = res.body.getReader();
    },
    async nextFrame(timeoutMs = 4000) {
      while (true) {
        const index = state.buffer.indexOf('\n\n');
        if (index !== -1) {
          const frame = state.buffer.slice(0, index);
          state.buffer = state.buffer.slice(index + 2);
          return frame;
        }
        const { done, value } = await readWithTimeout(timeoutMs);
        if (done) throw new Error('SSE stream ended unexpectedly');
        state.buffer += state.decoder.decode(value, { stream: true });
      }
    },
    close() {
      if (state.closed) return;
      state.closed = true;
      controller.abort();
    },
  };
}

async function main() {
  instance = await startServer({ port: 0, dataFile, quiet: true });

  const health = await jsonResponse(await request('/api/health'), 200);
  assert.equal(health.ok, true);
  assert.ok(health.time);
  step('health check');

  const preflight = await request('/api/connector/code', { method: 'OPTIONS' });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
  step('CORS preflight');

  const email = `self-test-${Date.now()}@example.com`;
  const password = 'correct-horse-battery';

  await jsonResponse(
    await request('/api/auth/signup', {
      method: 'POST',
      body: { email, name: 'Self Test', password: 'short' },
    }),
    400,
  );
  step('weak password rejected');

  const signup = await jsonResponse(
    await request('/api/auth/signup', {
      method: 'POST',
      body: { email, name: 'Self Test', password },
    }),
    201,
  );
  assert.equal(typeof signup.token, 'string');
  assert.equal(signup.token.length, 64);
  assert.deepEqual(Object.keys(signup.user).sort(), [
    'email', 'id', 'name', 'profile', 'profiles', 'type',
  ]);
  assert.equal(signup.user.email, email);
  assert.equal(signup.user.type, 'personal');
  assert.equal(signup.profile.type, 'personal');
  assert.equal(signup.user.profiles.length, 1);
  assert.ok(!JSON.stringify(signup).includes('passwordHash'));
  assert.ok(!JSON.stringify(signup).includes('passwordSalt'));
  step('signup returns token and public user only');

  await jsonResponse(
    await request('/api/auth/signup', {
      method: 'POST',
      body: { email, name: 'Duplicate', password },
    }),
    409,
  );
  step('duplicate email rejected');

  await jsonResponse(
    await request('/api/auth/login', {
      method: 'POST',
      body: { email, password: 'wrong-password' },
    }),
    401,
  );
  const login = await jsonResponse(
    await request('/api/auth/login', { method: 'POST', body: { email, password } }),
    200,
  );
  assert.equal(login.user.id, signup.user.id);
  step('login rejects bad password and accepts correct one');

  const token = login.token;
  const me = await jsonResponse(await request('/api/me', { token }), 200);
  assert.equal(me.user.id, signup.user.id);
  await jsonResponse(await request('/api/me'), 401);
  step('Bearer authentication');

  assert.deepEqual(Object.keys(me).sort(), ['profile', 'profiles', 'user']);
  assert.equal(me.user.type, 'personal');
  assert.equal(me.profile.id, signup.profile.id);
  assert.equal(me.profiles.length, 1);
  assert.ok(!JSON.stringify(me).includes('passwordHash'));
  step('/api/me returns user, profile and profiles');

  const typedEmail = `self-test-typed-${Date.now()}@example.com`;
  const typedSignup = await jsonResponse(
    await request('/api/auth/signup', {
      method: 'POST',
      body: { email: typedEmail, name: 'Typed User', password, type: 'developer' },
    }),
    201,
  );
  assert.equal(typedSignup.user.type, 'developer');
  assert.equal(typedSignup.profile.type, 'developer');
  assert.equal(typedSignup.user.profiles.length, 1);
  step('signup with explicit profile type');

  await jsonResponse(
    await request('/api/auth/signup', {
      method: 'POST',
      body: { email: `self-test-invalid-${Date.now()}@example.com`, name: 'Invalid', password, type: 'ghost' },
    }),
    400,
  );
  step('invalid profile type rejected');

  const typedLogin = await jsonResponse(
    await request('/api/auth/login', {
      method: 'POST',
      body: { email: typedEmail, password, type: 'developer' },
    }),
    200,
  );
  assert.equal(typedLogin.user.type, 'developer');
  // Requesting a type the account does not own falls back to the first profile.
  const fallbackLogin = await jsonResponse(
    await request('/api/auth/login', {
      method: 'POST',
      body: { email: typedEmail, password, type: 'business' },
    }),
    200,
  );
  assert.equal(fallbackLogin.user.type, 'developer');
  step('login with type binds token');

  const personalAgain = await jsonResponse(
    await request('/api/profiles', { method: 'POST', token, body: { type: 'personal' } }),
    200,
  );
  assert.equal(personalAgain.profile.id, signup.profile.id);
  assert.equal(personalAgain.profiles.length, 1);
  assert.notEqual(personalAgain.token, token);
  step('duplicate profile type is reused');

  const businessAdded = await jsonResponse(
    await request('/api/profiles', { method: 'POST', token, body: { type: 'business', name: 'Acme Inc.' } }),
    200,
  );
  const developerAdded = await jsonResponse(
    await request('/api/profiles', { method: 'POST', token, body: { type: 'developer' } }),
    200,
  );
  const businessToken = businessAdded.token;
  const developerToken = developerAdded.token;
  assert.notEqual(businessToken, developerToken);
  assert.equal(businessAdded.profile.name, 'Acme Inc.');
  assert.equal(developerAdded.profile.type, 'developer');
  assert.equal(businessAdded.user.profiles.length, 2);
  const profileList = await jsonResponse(await request('/api/profiles', { token }), 200);
  assert.deepEqual(profileList.profiles.map((profile) => profile.type), [
    'personal', 'business', 'developer',
  ]);
  step('/api/profiles GET and POST');

  const checkBusiness = await jsonResponse(
    await request('/api/auth/check?type=business', { token: businessToken }),
    200,
  );
  assert.equal(checkBusiness.allowed, true);
  assert.equal(checkBusiness.requiredType, 'business');
  assert.equal(checkBusiness.profileType, 'business');
  assert.equal(checkBusiness.needsSwitch, false);
  assert.equal(checkBusiness.profiles.length, 3);
  assert.ok(!JSON.stringify(checkBusiness).includes('password'));
  const checkSwitch = await jsonResponse(
    await request('/api/auth/check?type=business', { token }),
    200,
  );
  assert.equal(checkSwitch.allowed, true);
  assert.equal(checkSwitch.profileType, 'personal');
  assert.equal(checkSwitch.needsSwitch, true);
  const checkQueryToken = await jsonResponse(
    await request(`/api/auth/check?type=developer&token=${encodeURIComponent(token)}`),
    200,
  );
  assert.equal(checkQueryToken.allowed, true);
  assert.equal(checkQueryToken.needsSwitch, true);
  const checkMissing = await jsonResponse(
    await request('/api/auth/check?type=family', { token }),
    200,
  );
  assert.equal(checkMissing.allowed, false);
  assert.equal(checkMissing.needsSwitch, false);
  step('/api/auth/check reports access and switch needs');

  const forbidden = await jsonResponse(
    await request('/api/snapshot/business', {
      method: 'PUT',
      token,
      body: { data: { employees: [{ id: 'nope' }] } },
    }),
    403,
  );
  assert.equal(forbidden.error, 'Forbidden');
  assert.equal(forbidden.code, 'PROFILE_REQUIRED');
  assert.equal(forbidden.requiredType, 'business');
  assert.ok(Array.isArray(forbidden.profiles));
  step('business snapshot rejects personal token with 403');

  const pair = await jsonResponse(await request('/api/connector/code', { method: 'POST', token }), 200);
  assert.match(pair.code, /^\d{6}$/);
  assert.ok(Date.parse(pair.expiresAt) > Date.now() + 9 * 60 * 1000);
  step('connector code created');

  events = openEventStream(token);
  await events.ready();
  const greeting = await events.nextFrame();
  assert.equal(greeting.trim(), ': connected');
  step('SSE stream connected');

  const queryStream = await request(`/api/events?token=${encodeURIComponent(token)}`, {
    headers: { Accept: 'text/event-stream' },
  });
  assert.equal(queryStream.status, 200, 'SSE should accept token in query string');
  await queryStream.body.cancel();
  step('SSE accepts token query parameter');

  const redeemed = await jsonResponse(
    await request('/api/connector/redeem', { method: 'POST', body: { code: pair.code } }),
    200,
  );
  assert.equal(redeemed.user.id, signup.user.id);
  assert.equal(typeof redeemed.token, 'string');
  assert.equal(redeemed.profile.id, signup.profile.id);
  assert.equal(redeemed.profile.type, 'personal');
  step('connector code redeemed without auth');

  await jsonResponse(
    await request('/api/connector/redeem', { method: 'POST', body: { code: pair.code } }),
    400,
  );
  step('connector code is single use');

  const airoData = { accounts: [{ id: 'a1', balance: 100 }], currency: 'USD' };
  const putAiro = await jsonResponse(
    await request('/api/snapshot/airo', {
      method: 'PUT',
      token,
      body: { data: airoData, clientId: 'self-test-writer' },
    }),
    200,
  );
  assert.equal(putAiro.ok, true);
  assert.ok(putAiro.updatedAt);
  assert.equal(putAiro.clientId, 'self-test-writer');

  let frame = await events.nextFrame();
  if (!frame.includes('event: snapshot')) frame = await events.nextFrame();
  assert.match(frame, /^event: snapshot$/m);
  const dataLine = frame.split('\n').find((line) => line.startsWith('data: '));
  assert.ok(dataLine, 'SSE frame has a data line');
  const event = JSON.parse(dataLine.slice(6));
  assert.equal(event.app, 'airo');
  assert.equal(event.updatedAt, putAiro.updatedAt);
  assert.equal(event.clientId, 'self-test-writer');
  step('snapshot write broadcasts SSE event with clientId');

  const gotAiro = await jsonResponse(await request('/api/snapshot/airo', { token }), 200);
  assert.equal(gotAiro.app, 'airo');
  assert.deepEqual(gotAiro.data, airoData);
  assert.equal(gotAiro.updatedAt, putAiro.updatedAt);
  step('snapshot get returns stored data');

  await jsonResponse(
    await request('/api/snapshot/meridian', {
      method: 'PUT',
      token: redeemed.token,
      body: { data: { transactions: [1, 2, 3] } },
    }),
    200,
  );
  await jsonResponse(
    await request('/api/snapshot/tandem', {
      method: 'PUT',
      token,
      body: { data: { groups: [{ id: 'g1', name: 'Trip' }] } },
    }),
    200,
  );
  await jsonResponse(
    await request('/api/snapshot/business', {
      method: 'PUT',
      token: businessToken,
      body: { data: { employees: [{ id: 'e1', name: 'Avery' }] } },
    }),
    200,
  );
  await jsonResponse(
    await request('/api/snapshot/developer', {
      method: 'PUT',
      token: developerToken,
      body: { data: { payments: [{ id: 'p1', amount: 250 }] } },
    }),
    200,
  );
  const status = await jsonResponse(await request('/api/connector/status', { token }), 200);
  assert.deepEqual(status.linked, { meridian: true, airo: true, tandem: true, business: true, developer: true });
  assert.ok(status.updatedAt.meridian && status.updatedAt.airo && status.updatedAt.tandem && status.updatedAt.business && status.updatedAt.developer);
  step('status reports linked apps and timestamps');

  // ---- Shared calendar ----------------------------------------------------
  await jsonResponse(
    await request('/api/calendar/events', {
      method: 'POST', token, body: { title: '', start: '2026-11-25T10:00:00Z' },
    }),
    400,
  );
  await jsonResponse(
    await request('/api/calendar/events', {
      method: 'POST', token, body: { title: 'Bad date', start: 'not-a-date' },
    }),
    400,
  );
  const createdEvent = await jsonResponse(
    await request('/api/calendar/events', {
      method: 'POST',
      token,
      body: {
        title: 'Team sync',
        start: '2026-11-25T10:00:00Z',
        end: '2026-11-25T11:00:00Z',
        description: 'Weekly',
        location: 'Room 1',
        category: 'work',
      },
    }),
    201,
  );
  const created = createdEvent.event;
  assert.equal(created.app, 'calendar');
  assert.equal(created.sourceId, null);
  assert.equal(created.profileId, signup.profile.id);
  assert.equal(created.status, 'active');
  assert.equal(created.allDay, false);
  const createFrame = await nextNamedFrame(events, 'calendar');
  assert.equal(frameData(createFrame).action, 'create');
  assert.equal(frameData(createFrame).event.id, created.id);

  const listed = await jsonResponse(
    await request('/api/calendar/events?from=2026-11-01T00:00:00Z&to=2026-11-30T00:00:00Z', { token }),
    200,
  );
  assert.ok(listed.events.some((event) => event.id === created.id));
  const businessEvents = await jsonResponse(
    await request('/api/calendar/events?type=business', { token }),
    200,
  );
  assert.ok(!businessEvents.events.some((event) => event.id === created.id));

  const patched = await jsonResponse(
    await request(`/api/calendar/events/${created.id}`, {
      method: 'PATCH', token, body: { title: 'Team sync moved', allDay: true },
    }),
    200,
  );
  assert.equal(patched.event.title, 'Team sync moved');
  assert.equal(patched.event.allDay, true);
  assert.equal(patched.event.id, created.id);
  assert.equal(frameData(await nextNamedFrame(events, 'calendar')).action, 'update');

  // Another user's token cannot touch this event.
  await jsonResponse(
    await request(`/api/calendar/events/${created.id}`, {
      method: 'PATCH', token: typedLogin.token, body: { title: 'Hijacked' },
    }),
    404,
  );
  await jsonResponse(
    await request(`/api/calendar/events/${created.id}`, { method: 'DELETE', token: typedLogin.token }),
    404,
  );
  const deleted = await jsonResponse(
    await request(`/api/calendar/events/${created.id}`, { method: 'DELETE', token }),
    200,
  );
  assert.equal(deleted.ok, true);
  const deleteFrame = await nextNamedFrame(events, 'calendar');
  assert.equal(frameData(deleteFrame).action, 'delete');
  assert.equal(frameData(deleteFrame).event.id, created.id);
  const afterCalendarDelete = await jsonResponse(await request('/api/calendar/events', { token }), 200);
  assert.ok(!afterCalendarDelete.events.some((event) => event.id === created.id));
  step('calendar event create/list/update/delete');

  const syncBody = {
    app: 'airo',
    sourcePrefix: 'airo:bills:',
    events: [
      { sourceId: 'airo:bills:1', title: 'Rent', start: '2026-12-01', category: 'bills' },
      { sourceId: 'airo:bills:2', title: 'Power', start: '2026-12-05' },
    ],
  };
  const syncedOnce = await jsonResponse(
    await request('/api/calendar/events/sync', { method: 'PUT', token, body: syncBody }),
    200,
  );
  assert.equal(syncedOnce.count, 2);
  const syncedTwice = await jsonResponse(
    await request('/api/calendar/events/sync', { method: 'PUT', token, body: syncBody }),
    200,
  );
  assert.equal(syncedTwice.count, 2);
  const expectedId = `evt_${crypto
    .createHash('sha256')
    .update(`${signup.user.id}airo:bills:1`)
    .digest('hex')
    .slice(0, 16)}`;
  const syncedList = await jsonResponse(
    await request('/api/calendar/events?from=2026-12-01T00:00:00Z&to=2026-12-31T00:00:00Z', { token }),
    200,
  );
  assert.equal(syncedList.events.length, 2);
  assert.equal(syncedList.events[0].id, expectedId);
  assert.equal(syncedList.events[0].sourceId, 'airo:bills:1');
  assert.equal(syncedList.events[0].app, 'airo');

  // Events with the prefix that are no longer supplied get removed.
  const pruned = await jsonResponse(
    await request('/api/calendar/events/sync', {
      method: 'PUT',
      token,
      body: { ...syncBody, events: [syncBody.events[0]] },
    }),
    200,
  );
  assert.equal(pruned.count, 1);
  const prunedList = await jsonResponse(
    await request('/api/calendar/events?from=2026-12-01T00:00:00Z&to=2026-12-31T00:00:00Z', { token }),
    200,
  );
  assert.equal(prunedList.events.length, 1);
  for (let i = 0; i < 3; i += 1) {
    const refreshFrame = await nextNamedFrame(events, 'calendar');
    assert.equal(frameData(refreshFrame).action, 'refresh');
    assert.equal(frameData(refreshFrame).app, 'airo');
  }
  step('calendar sync is idempotent and broadcasts refresh');

  await jsonResponse(
    await request('/api/snapshot/airo', {
      method: 'PUT',
      token,
      body: {
        data: {
          recurring: [
            { id: 'r1', name: 'Gym', nextDate: '2026-12-02' },
            { id: 'bad', nextDate: 'nonsense' },
            null,
            7,
          ],
          goals: [{ id: 'g1', title: 'Launch', deadline: '2026-12-03' }],
          invoices: [{ id: 'i1', title: 'Invoice 9', dueDate: '2026-12-04' }],
        },
      },
    }),
    200,
  );
  await jsonResponse(
    await request('/api/snapshot/business', {
      method: 'PUT',
      token: businessToken,
      body: {
        data: {
          payroll: [{ id: 'p1', date: '2026-12-06' }, { id: 'p2', payDate: '2026-12-07' }],
          invoices: [{ id: 'bi1', title: 'Bill', dueDate: '2026-12-08' }],
          debts: [],
          employees: [{ id: 'e2', name: 'No date here' }],
        },
      },
    }),
    200,
  );
  await jsonResponse(
    await request('/api/snapshot/developer', {
      method: 'PUT',
      token: developerToken,
      body: {
        data: {
          invoices: [{ id: 'di1', dueDate: '2026-12-09' }],
          subscriptions: [{ id: 's1', nextDate: '2026-12-10' }],
          payouts: [{ id: 'po1', date: '2026-12-11' }],
        },
      },
    }),
    200,
  );
  await jsonResponse(
    await request('/api/snapshot/meridian', {
      method: 'PUT',
      token,
      body: { data: { goals: [{ id: 'mg1', deadline: '2026-12-12' }] } },
    }),
    200,
  );
  const manyExpenses = Array.from({ length: 30 }, (_, index) => ({
    id: `x${index}`,
    date: `2026-11-${String(index + 1).padStart(2, '0')}`,
  }));
  await jsonResponse(
    await request('/api/snapshot/tandem', {
      method: 'PUT',
      token,
      body: { data: { expenses: manyExpenses } },
    }),
    200,
  );
  const derived = await jsonResponse(await request('/api/calendar/derived', { token }), 200);
  const derivedIds = derived.events.map((event) => event.sourceId);
  for (const sourceId of [
    'airo:recurring:r1', 'airo:goals:g1', 'airo:invoices:i1',
    'business:payroll:p1', 'business:payroll:p2', 'business:invoices:bi1',
    'developer:invoices:di1', 'developer:subscriptions:s1', 'developer:payouts:po1',
    'meridian:goals:mg1',
  ]) {
    assert.ok(derivedIds.includes(sourceId), `missing derived event ${sourceId}`);
  }
  assert.ok(!derivedIds.some((sourceId) => sourceId.includes('/bad') || sourceId.includes('/e2')));
  assert.equal(derived.events.filter((event) => event.sourceId.startsWith('tandem:expenses:')).length, 25);
  assert.ok(derived.events.every((event) => Number.isFinite(Date.parse(event.start))));
  assert.equal(
    derived.events.find((event) => event.sourceId === 'business:payroll:p1').profileId,
    businessAdded.profile.id,
  );
  assert.equal(
    derived.events.find((event) => event.sourceId === 'airo:recurring:r1').profileId,
    signup.profile.id,
  );
  const sortedStarts = derived.events.map((event) => Date.parse(event.start));
  assert.deepEqual(sortedStarts, [...sortedStarts].sort((a, b) => a - b));
  step('derived events from stored app snapshots');

  await jsonResponse(await request('/api/snapshot/not-an-app', { token }), 400);
  await jsonResponse(await request('/api/snapshot/airo', { method: 'DELETE', token }), 200);
  const afterDelete = await jsonResponse(await request('/api/snapshot/airo', { token }), 200);
  assert.deepEqual(afterDelete, { app: 'airo', data: null, updatedAt: null });
  step('invalid app rejected and snapshot delete works');

  // One code was already created above; nine more reach the hourly limit of 10.
  for (let i = 0; i < 9; i += 1) {
    await jsonResponse(await request('/api/connector/code', { method: 'POST', token }), 200);
  }
  const limited = await jsonResponse(
    await request('/api/connector/code', { method: 'POST', token }),
    429,
  );
  assert.ok(limited.retryAfter > 0);
  step('connector code rate limit enforced');

  const stored = JSON.parse(await fs.readFile(dataFile, 'utf8'));
  assert.equal(stored.users.length, 2);
  assert.equal(stored.profiles.length, 4);
  assert.equal(stored.tokens[token].profileId, signup.profile.id);
  assert.equal(stored.tokens[businessToken].profileId, businessAdded.profile.id);
  assert.equal(stored.events.length, 1);
  assert.ok(!JSON.stringify(stored).includes(password), 'plaintext password found on disk');
  assert.ok(stored.users[0].passwordHash && stored.users[0].passwordSalt);
  step('state persisted atomically without plaintext passwords');

  events.close();
  events = null;
  await instance.close();
  instance = null;

  instance = await startServer({ port: 0, dataFile, quiet: true });
  const relogin = await jsonResponse(
    await request('/api/auth/login', { method: 'POST', body: { email, password, type: 'business' } }),
    200,
  );
  assert.equal(relogin.user.id, signup.user.id);
  assert.equal(relogin.user.type, 'business');
  assert.equal(relogin.user.profiles.length, 3);
  const kept = await jsonResponse(await request('/api/snapshot/meridian', { token: relogin.token }), 200);
  assert.deepEqual(kept.data, { goals: [{ id: 'mg1', deadline: '2026-12-12' }] });
  const keptEvents = await jsonResponse(
    await request('/api/calendar/events', { token: relogin.token }),
    200,
  );
  assert.equal(keptEvents.events.length, 1);
  assert.equal(keptEvents.events[0].sourceId, 'airo:bills:1');
  step('data survives a server restart');

  console.log('\natlas-sync self-test: ALL PASSED');
}

try {
  await main();
} catch (err) {
  console.error('\natlas-sync self-test: FAILED');
  console.error(err);
  process.exitCode = 1;
} finally {
  try {
    events?.close();
    if (instance) await instance.close();
  } catch (err) {
    console.error('cleanup error:', err);
    process.exitCode = 1;
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
}
