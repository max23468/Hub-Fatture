ALTER TABLE sync_cursors
  ADD COLUMN aruba_status_mapper_version integer
  CHECK (aruba_status_mapper_version IS NULL OR aruba_status_mapper_version > 0);
