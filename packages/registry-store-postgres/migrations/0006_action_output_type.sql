-- The Type of the object an Action's result is (ADR-0075), so a result returned
-- to a caller reading for a model is released as that object would be read.
-- Nullable: Actions written before it read back without one, as they were.
ALTER TABLE actions ADD COLUMN output_type TEXT;
