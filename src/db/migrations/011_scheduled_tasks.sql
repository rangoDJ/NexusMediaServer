-- Persisted trigger configuration per task.
-- Rows are upserted at startup from default task definitions, then updated
-- when the admin changes triggers via the API.
CREATE TABLE IF NOT EXISTS scheduled_task_configs (
  task_id     TEXT        PRIMARY KEY,
  triggers    JSONB       NOT NULL DEFAULT '[]',
  is_enabled  BOOLEAN     NOT NULL DEFAULT true,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Execution history — one row per run.
-- Only the most recent MAX_HISTORY rows per task are kept (pruned by the scheduler).
CREATE TABLE IF NOT EXISTS task_results (
  id            BIGSERIAL   PRIMARY KEY,
  task_id       TEXT        NOT NULL,
  status        TEXT        NOT NULL CHECK (status IN ('completed', 'failed', 'cancelled')),
  started_at    TIMESTAMPTZ NOT NULL,
  ended_at      TIMESTAMPTZ,
  duration_ms   INT,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_task_results_task_id
  ON task_results (task_id, started_at DESC);
