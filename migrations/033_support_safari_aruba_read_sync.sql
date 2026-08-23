ALTER TABLE aruba_sync_sessions
  DROP CONSTRAINT aruba_sync_sessions_browser_name_check,
  ADD CONSTRAINT aruba_sync_sessions_browser_name_check
    CHECK (browser_name IS NULL OR browser_name IN ('chrome', 'msedge', 'safari'));
