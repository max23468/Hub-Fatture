ALTER TABLE billing_cases DROP COLUMN public_number;
ALTER TABLE billing_cases
  ADD COLUMN public_number text GENERATED ALWAYS AS (
    repeat('0', greatest(6 - length(id::text), 0)) || id::text
  ) STORED UNIQUE;
