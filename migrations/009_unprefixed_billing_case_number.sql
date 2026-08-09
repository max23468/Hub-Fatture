ALTER TABLE billing_cases DROP COLUMN public_number;
ALTER TABLE billing_cases
  ADD COLUMN public_number text GENERATED ALWAYS AS (lpad(id::text, 6, '0')) STORED UNIQUE;
