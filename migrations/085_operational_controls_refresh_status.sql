CREATE TABLE operational_controls_refresh_status (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  last_completed_at timestamptz,
  last_failed_at timestamptz
);

INSERT INTO operational_controls_refresh_status (singleton) VALUES (true);
