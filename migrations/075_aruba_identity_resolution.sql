ALTER TABLE aruba_deduplication_conflicts
  ADD COLUMN resolution_json jsonb,
  ADD COLUMN resolved_by smallint REFERENCES users(id),
  ADD COLUMN resolution_reason text;
