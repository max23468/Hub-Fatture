CREATE TABLE aruba_api_traffic_limits (
  api_environment text NOT NULL CHECK (api_environment IN ('DEMO', 'PRODUCTION')),
  scope text NOT NULL CHECK (scope IN ('GLOBAL_PROVIDER', 'INVOICE_READ', 'NOTIFICATION_READ')),
  next_allowed_at timestamptz NOT NULL DEFAULT now(),
  cooldown_until timestamptz,
  last_rate_limited_at timestamptz,
  reserved_request_count bigint NOT NULL DEFAULT 0 CHECK (reserved_request_count >= 0),
  rate_limited_count integer NOT NULL DEFAULT 0 CHECK (rate_limited_count >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (api_environment, scope),
  CONSTRAINT aruba_api_traffic_cooldown_check CHECK (
    cooldown_until IS NULL OR last_rate_limited_at IS NOT NULL
  )
);

COMMENT ON TABLE aruba_api_traffic_limits IS
  'Coordinamento fail-closed dei limiti Aruba fra processi e istanze applicative.';
