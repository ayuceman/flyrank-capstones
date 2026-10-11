-- 001_initial: plans, tenants, subscriptions, usage events, stripe event log, jobs, alerts.
-- Money is integer micro-dollars everywhere. Never floats.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE plans (
  id               TEXT PRIMARY KEY,                 -- 'free' | 'pro'
  name             TEXT NOT NULL,
  api_calls_limit  INTEGER NOT NULL CHECK (api_calls_limit >= 0),
  ai_tokens_limit  BIGINT  NOT NULL CHECK (ai_tokens_limit >= 0),
  price_cents      INTEGER NOT NULL DEFAULT 0,
  stripe_price_id  TEXT
);

CREATE TABLE tenants (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 TEXT NOT NULL,
  api_key_hash         TEXT NOT NULL UNIQUE,         -- sha256 of the key; the key itself is shown once
  plan_id              TEXT NOT NULL REFERENCES plans(id) DEFAULT 'free',
  stripe_customer_id   TEXT UNIQUE,
  subscription_status  TEXT NOT NULL DEFAULT 'none'
                       CHECK (subscription_status IN ('none','active','past_due','canceled')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE subscriptions (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  stripe_subscription_id  TEXT NOT NULL UNIQUE,
  plan_id                 TEXT NOT NULL REFERENCES plans(id),
  status                  TEXT NOT NULL,
  current_period_start    TIMESTAMPTZ,
  current_period_end      TIMESTAMPTZ,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX subscriptions_tenant_idx ON subscriptions (tenant_id);

CREATE TABLE usage_events (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  type             TEXT NOT NULL CHECK (type IN ('api_call','ai_tokens')),
  quantity         BIGINT NOT NULL CHECK (quantity >= 0),
  breakdown        JSONB,                            -- tokens: {input, cached_input, output, reasoning}
  cost_micros      BIGINT NOT NULL DEFAULT 0,        -- micro-dollars
  period           CHAR(7) NOT NULL,                 -- 'YYYY-MM' in UTC
  idempotency_key  TEXT NOT NULL,
  request_hash     TEXT NOT NULL,
  response_status  INTEGER NOT NULL,
  response         JSONB NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- the whole idempotency guarantee lives here
CREATE UNIQUE INDEX usage_events_idem_idx ON usage_events (tenant_id, idempotency_key);
-- the rollup query: everything this tenant did this month, by type
CREATE INDEX usage_events_rollup_idx ON usage_events (tenant_id, period, type);

CREATE TABLE stripe_events (
  id            TEXT PRIMARY KEY,                    -- evt_... from Stripe; replay = pk conflict = ignored
  type          TEXT NOT NULL,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at  TIMESTAMPTZ
);

CREATE TABLE jobs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type          TEXT NOT NULL,
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL DEFAULT 5,
  run_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ
);
CREATE INDEX jobs_due_idx ON jobs (status, run_at);

CREATE TABLE usage_alerts (
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  period      CHAR(7) NOT NULL,
  type        TEXT NOT NULL,
  threshold   INTEGER NOT NULL CHECK (threshold IN (80, 100)),
  sent_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, period, type, threshold)
);

INSERT INTO plans (id, name, api_calls_limit, ai_tokens_limit, price_cents) VALUES
  ('free', 'Free', 1000,   100000,  0),
  ('pro',  'Pro',  50000,  5000000, 2900);
