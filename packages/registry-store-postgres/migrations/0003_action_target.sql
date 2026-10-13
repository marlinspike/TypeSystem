-- The object an instance-scoped Action acts on (ADR-0053): which input property
-- carries its id, and its Type. Nullable, so Actions written before it read back
-- as type-scoped, as they were.
ALTER TABLE actions ADD COLUMN target JSONB;
