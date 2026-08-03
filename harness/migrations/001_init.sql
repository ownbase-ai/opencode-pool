-- Affinity + leasing for the opencode worker pool.
-- Session.worker_idx is immutable: state lives on that replica's volume.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS worker (
  idx        int PRIMARY KEY,
  healthy    boolean NOT NULL DEFAULT false,
  draining   boolean NOT NULL DEFAULT false,
  version    text,
  last_seen  timestamptz,
  load       int NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS session (
  id           text PRIMARY KEY,
  worker_idx   int NOT NULL REFERENCES worker(idx),
  directory    text,
  title        text,
  status       text NOT NULL DEFAULT 'open',
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS session_worker_last_used_idx
  ON session (worker_idx, last_used_at DESC);

CREATE TABLE IF NOT EXISTS lease (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  text NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  worker_idx  int  NOT NULL,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  released_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_lease_per_worker
  ON lease (worker_idx) WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS lease_session_idx ON lease (session_id);
