-- Reference schema for AtlasSyncDO. The worker executes the same idempotent
-- CREATE TABLE statements on first request, so this file is documentation only.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE,
  name TEXT,
  salt TEXT,
  hash TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  type TEXT,
  name TEXT,
  status TEXT,
  created_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS profiles_user_type ON profiles(user_id, type);

CREATE TABLE IF NOT EXISTS tokens (
  token TEXT PRIMARY KEY,
  user_id TEXT,
  profile_id TEXT,
  created_at TEXT
);
-- Legacy v1 rows may have NULL profile_id; the worker treats NULL as the
-- user's first (oldest) profile and lazily binds the token to it.

CREATE TABLE IF NOT EXISTS connector_codes (
  code_hash TEXT PRIMARY KEY,
  user_id TEXT,
  expires_at TEXT,
  used INTEGER DEFAULT 0,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS snapshots (
  user_id TEXT,
  app TEXT,
  data TEXT,
  updated_at TEXT,
  PRIMARY KEY(user_id, app)
);

CREATE TABLE IF NOT EXISTS calendar_events (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  profile_id TEXT,
  app TEXT,
  source_id TEXT,
  title TEXT,
  description TEXT,
  start_at TEXT,
  end_at TEXT,
  all_day INTEGER,
  location TEXT,
  category TEXT,
  status TEXT,
  created_at TEXT,
  updated_at TEXT,
  UNIQUE(user_id, source_id)
);
-- source_id is NULL for manually created events; SQLite allows multiple NULLs
-- in a UNIQUE constraint. App-derived events use <app>:<collection>:<id>.
