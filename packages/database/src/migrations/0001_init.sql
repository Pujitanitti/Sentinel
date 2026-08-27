-- 0001_init.sql
-- Core schema for Sentinel's durable configuration + historical data.
-- High-frequency counters (rate limits, live risk scores, active blocks)
-- live in Redis, not here — see docs/system-design.md for the rationale.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT UNIQUE NOT NULL,
  route TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT '*',
  "limit" INTEGER NOT NULL CHECK ("limit" > 0),
  window_seconds INTEGER NOT NULL CHECK (window_seconds > 0),
  strategy TEXT NOT NULL CHECK (strategy IN ('fixed-window', 'sliding-window', 'token-bucket')),
  identity_types TEXT[] NOT NULL DEFAULT ARRAY['ip'],
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_policies_enabled ON policies (enabled);

CREATE TABLE IF NOT EXISTS api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  key_hash TEXT UNIQUE NOT NULL,
  policy_names TEXT[] NOT NULL DEFAULT '{}',
  revoked BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_api_keys_key_hash ON api_keys (key_hash);
CREATE INDEX IF NOT EXISTS idx_api_keys_revoked ON api_keys (revoked);

CREATE TABLE IF NOT EXISTS blocked_entities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_type TEXT NOT NULL,
  identity_value TEXT NOT NULL,
  reason TEXT NOT NULL,
  permanent BOOLEAN NOT NULL DEFAULT false,
  blocked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  removed_at TIMESTAMPTZ,
  UNIQUE (identity_type, identity_value, blocked_at)
);

CREATE INDEX IF NOT EXISTS idx_blocked_entities_identity ON blocked_entities (identity_type, identity_value);

CREATE TABLE IF NOT EXISTS security_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL,
  identity_type TEXT NOT NULL,
  identity_value TEXT NOT NULL,
  route TEXT,
  risk_score INTEGER,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_security_events_created_at ON security_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_security_events_identity ON security_events (identity_type, identity_value);
CREATE INDEX IF NOT EXISTS idx_security_events_type ON security_events (type);

CREATE TABLE IF NOT EXISTS request_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  status INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL,
  identity TEXT NOT NULL,
  decision TEXT NOT NULL,
  policy_name TEXT,
  risk_score INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_request_logs_created_at ON request_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_request_logs_path ON request_logs (path);
CREATE INDEX IF NOT EXISTS idx_request_logs_identity ON request_logs (identity);
