ALTER TABLE aruba_batches
  ADD COLUMN account_identity text,
  ADD COLUMN manifest_version smallint NOT NULL DEFAULT 1;

ALTER TABLE aruba_batches
  ADD CONSTRAINT aruba_batches_manifest_version_check
    CHECK (manifest_version IN (1, 2)),
  ADD CONSTRAINT aruba_batches_account_identity_check
    CHECK (
      (manifest_version = 1 AND account_identity IS NULL)
      OR
      (manifest_version = 2 AND account_identity IS NOT NULL
       AND length(account_identity) BETWEEN 1 AND 200)
    );
