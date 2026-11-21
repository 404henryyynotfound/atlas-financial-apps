/**
 * Local validation for atlas-sync-worker. No Cloudflare credentials, no network,
 * no dependencies. Run with: npm test
 *
 * Checks static invariants (config, routes, schema, security) and a small
 * in-process smoke test of the Worker entry point with a fake DO stub.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const load = (name) => fs.readFile(path.join(root, name), 'utf8');

function step(message) {
  console.log(`  ✓ ${message}`);
}

async function main() {
  const [workerSource, wranglerConfig, schema] = await Promise.all([
    load('worker.js'), load('wrangler.toml'), load('schema.sql'),
  ]);

  // ---- Syntax ------------------------------------------------------------
  const syntax = spawnSync(process.execPath, ['--check', path.join(root, 'worker.js')], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, `worker.js syntax error:\n${syntax.stderr}`);
  step('worker.js passes node --check');

  // ---- Cloudflare configuration -----------------------------------------
  assert.match(wranglerConfig, /main\s*=\s*"worker\.js"/);
  assert.match(wranglerConfig, /compatibility_date\s*=\s*"2026-11-21"/);
  assert.match(wranglerConfig, /name\s*=\s*"ATLAS_SYNC"/);
  assert.match(wranglerConfig, /class_name\s*=\s*"AtlasSyncDO"/);
  assert.match(wranglerConfig, /new_sqlite_classes\s*=\s*\[\s*"AtlasSyncDO"\s*\]/);
  assert.match(wranglerConfig, /tag\s*=\s*"v1"/);
  assert.match(wranglerConfig, /ALLOWED_ORIGIN\s*=\s*"\*"/);
  step('wrangler.toml has SQLite DO binding, v1 migration and CORS var');

  // ---- Schema ------------------------------------------------------------
  for (const table of ['users', 'profiles', 'tokens', 'connector_codes', 'snapshots', 'calendar_events']) {
    assert.match(schema, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`), `schema.sql missing ${table}`);
  }
  assert.match(schema, /profile_id TEXT/);
  assert.match(schema, /UNIQUE\(user_id, source_id\)/);
  assert.match(schema, /UNIQUE INDEX IF NOT EXISTS profiles_user_type ON profiles\(user_id, type\)/);
  step('schema.sql documents all tables, profile_id and uniqueness');

  // ---- Original API contract --------------------------------------------
  const routes = [
    '/api/health',
    '/api/auth/signup',
    '/api/auth/login',
    '/api/me',
    '/api/connector/code',
    '/api/connector/redeem',
    '/api/connector/status',
    '/api/events',
  ];
  for (const route of routes) {
    assert.ok(workerSource.includes(route), `worker.js missing original route ${route}`);
  }
  // The snapshot route is matched with a regex so apps can use any slug.
  assert.ok(workerSource.includes('/api\\/snapshot\\/'));
  step('all original API routes are present');

  const apps = ['meridian', 'airo', 'tandem', 'business', 'developer'];
  for (const app of apps) assert.ok(workerSource.includes(`'${app}'`), `missing app slug ${app}`);
  step('all five app slugs are present');

  assert.match(workerSource, /allowQueryToken/);
  assert.match(workerSource, /searchParams\.get\(['"]token['"]\)/);
  assert.match(workerSource, /event: snapshot\\ndata:/);
  step('EventSource ?token support and snapshot SSE frame preserved');

  assert.match(workerSource, /PBKDF2_ITERATIONS\s*=\s*100000/);
  assert.match(workerSource, /importKey\('raw'.*'PBKDF2'/);
  assert.match(workerSource, /deriveBits\(/);
  assert.match(workerSource, /hash:\s*'SHA-256'/);
  assert.match(workerSource, /CODE_PEPPER/);
  step('salted PBKDF2-SHA256 (100000) and peppered code digests');

  // ---- Unified profiles / gating / calendar ------------------------------
  for (const type of ['personal', 'family', 'business', 'developer']) {
    assert.ok(workerSource.includes(`'${type}'`), `missing profile type ${type}`);
  }
  for (const route of [
    '/api/profiles',
    '/api/auth/check',
    '/api/calendar/events',
    '/api/calendar/events/sync',
    '/api/calendar/derived',
  ]) {
    assert.ok(workerSource.includes(route), `worker.js missing new route ${route}`);
  }
  assert.match(workerSource, /event: calendar\\ndata:/);
  assert.match(workerSource, /PROFILE_REQUIRED/);
  assert.match(workerSource, /requiredType/);
  assert.match(workerSource, /requireProfileType\(env, request, allowedTypes\)/);
  assert.match(workerSource, /ALTER TABLE tokens ADD COLUMN profile_id TEXT/);
  assert.match(workerSource, /CREATE TABLE IF NOT EXISTS calendar_events/);
  step('profiles, gating (403 PROFILE_REQUIRED) and calendar APIs are present');

  // ---- No third-party auth or embedded secrets ---------------------------
  const securitySources = [workerSource, wranglerConfig, schema];
  for (const source of securitySources) assert.doesNotMatch(source, /google|oauth/i);
  step('no Google/OAuth references');

  const secretPatterns = [
    /(?:sk|pk)_(?:live|test)_[A-Za-z0-9]+/,
    /AKIA[0-9A-Z]{16}/,
    /-----BEGIN [A-Z ]+PRIVATE KEY-----/,
    /(?:ghp|gho|github_pat)_[A-Za-z0-9_]+/,
    /\b(?:CODE_PEPPER|ALLOWED_ORIGIN)\s*[:=]\s*["'](?!\*["'])[^"']{8,}["']/i,
  ];
  for (const source of securitySources) {
    for (const pattern of secretPatterns) assert.doesNotMatch(source, pattern, 'possible embedded secret');
  }
  step('no hardcoded secrets or API keys');

  // ---- In-process Worker smoke test --------------------------------------
  if (typeof globalThis.DurableObject === 'undefined') {
    globalThis.DurableObject = class DurableObject {};
  }
  const worker = await import(pathToFileURL(path.join(root, 'worker.js')).href);
  assert.equal(typeof worker.default?.fetch, 'function');
  assert.equal(typeof worker.AtlasSyncDO, 'function');
  step('worker module exports default.fetch and AtlasSyncDO');

  let forwarded = null;
  const env = {
    ATLAS_SYNC: {
      idFromName(name) {
        assert.equal(name, 'atlas-sync-global');
        return 'global-id';
      },
      get(id) {
        assert.equal(id, 'global-id');
        return {
          fetch(request) {
            forwarded = request;
            return new Response(JSON.stringify({ ok: true, via: 'do' }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
          },
        };
      },
    },
  };
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  const call = (url, init) => worker.default.fetch(new Request(url, init), env, ctx);

  const health = await call('https://sync.test/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.headers.get('access-control-allow-origin'), '*');
  const healthBody = await health.json();
  assert.equal(healthBody.ok, true);
  assert.equal(healthBody.service, 'atlas-sync-worker');
  assert.ok(healthBody.time);
  assert.deepEqual(Object.keys(healthBody).sort(), ['ok', 'service', 'time']);
  step('GET /api/health returns JSON with CORS');

  const preflight = await call('https://sync.test/api/connector/code', { method: 'OPTIONS' });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
  step('OPTIONS returns 204 with permissive CORS');

  const missing = await call('https://sync.test/not-an-api');
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: 'Not found' });
  step('unknown paths return 404 JSON');

  const me = await call('https://sync.test/api/me', { headers: { Authorization: 'Bearer test-token' } });
  assert.equal(me.status, 200);
  assert.equal(new URL(forwarded.url).pathname, '/api/me');
  assert.equal(forwarded.headers.get('authorization'), 'Bearer test-token');
  step('authenticated /api/* requests route to the global DO');

  const stream = await call('https://sync.test/api/events?token=event-token');
  assert.equal(stream.status, 200);
  assert.equal(new URL(forwarded.url).searchParams.get('token'), 'event-token');
  step('SSE ?token query is forwarded unchanged to the DO');

  const check = await call('https://sync.test/api/auth/check?type=business');
  assert.equal(check.status, 200);
  assert.equal(new URL(forwarded.url).searchParams.get('type'), 'business');
  step('auth capability check is forwarded with its type query');

  console.log('\natlas-sync-worker validation: ALL PASSED');
}

try {
  await main();
} catch (err) {
  console.error('\natlas-sync-worker validation: FAILED');
  console.error(err);
  process.exitCode = 1;
}
