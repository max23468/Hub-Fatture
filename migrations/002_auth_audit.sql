CREATE TABLE login_attempts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username text NOT NULL,
  successful boolean NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX login_attempts_rate_limit_idx ON login_attempts (username, attempted_at DESC);

CREATE TABLE audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_type text NOT NULL,
  actor_id text,
  action text NOT NULL,
  event_class text NOT NULL CHECK (event_class IN ('CRITICAL', 'OPERATIONAL')),
  entity_type text NOT NULL,
  entity_id text,
  metadata_json jsonb NOT NULL DEFAULT '{}',
  request_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_events_entity_idx ON audit_events (entity_type, entity_id, created_at DESC);
