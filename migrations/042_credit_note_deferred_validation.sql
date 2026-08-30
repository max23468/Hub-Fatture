CREATE OR REPLACE FUNCTION validate_credit_note_total() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM documents WHERE id = NEW.id)
     AND NOT coalesce(credit_note_total_matches(NEW.id), false) THEN
    RAISE EXCEPTION 'Il totale della nota non coincide con i rimborsi collegati';
  END IF;
  RETURN NEW;
END;
$$;
