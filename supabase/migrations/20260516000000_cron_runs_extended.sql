-- CAMBIO 3: Extend cron_runs with fields needed by /api/health/full.
--
-- cron_runs was created directly in Supabase (not tracked in migrations).
-- This migration is fully idempotent:
--   1. CREATE TABLE IF NOT EXISTS → creates a minimal table if absent.
--   2. ADD COLUMN IF NOT EXISTS → adds the new CAMBIO 3 columns regardless.

CREATE TABLE IF NOT EXISTS cron_runs (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at      TIMESTAMPTZ NOT NULL    DEFAULT now(),
  workflow        TEXT        NOT NULL    DEFAULT 'analyze',
  duration_ms     INT         NOT NULL    DEFAULT 0,
  generated_picks INT         NOT NULL    DEFAULT 0,
  errors          JSONB
);

CREATE INDEX IF NOT EXISTS idx_cron_runs_started_at          ON cron_runs (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_cron_runs_workflow_started_at ON cron_runs (workflow, started_at DESC);

-- New columns for CAMBIO 3 health endpoint
ALTER TABLE cron_runs
  ADD COLUMN IF NOT EXISTS games_fetched    INT  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS games_in_window  INT  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS games_analyzed   INT  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS anthropic_status TEXT NOT NULL DEFAULT 'skipped';

COMMENT ON COLUMN cron_runs.anthropic_status IS
  'ok = Claude was called and succeeded | 529 = overloaded (retried) | error = non-529 failure | skipped = no games in window';
