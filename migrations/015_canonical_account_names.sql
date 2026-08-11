ALTER TABLE users
  DROP CONSTRAINT users_username_check,
  DROP CONSTRAINT users_approval_identity_check;

UPDATE users
SET username = CASE username
  WHEN 'matteo' THEN 'Massimo'
  WHEN 'codex' THEN 'Codex'
  ELSE username
END;

ALTER TABLE users
  ADD CONSTRAINT users_username_canonical_check
  CHECK (username IN ('Massimo', 'Codex')),
  ADD CONSTRAINT users_approval_identity_check
  CHECK (can_approve = (username = 'Massimo'));

CREATE UNIQUE INDEX users_username_case_insensitive_idx ON users (lower(username));
