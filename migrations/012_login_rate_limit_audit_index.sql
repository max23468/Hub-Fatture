CREATE INDEX audit_events_login_rate_scope_idx
  ON audit_events ((metadata_json ->> 'scope'), created_at DESC)
  WHERE action = 'LOGIN_RATE_LIMITED';
