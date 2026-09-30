-- The runtime operation an audit row was written under (ADR-0042): the outermost
-- call — `query` for a decision inside a query's include, `listActions` for a
-- preview. Nullable, so rows written before it read back without one.
ALTER TABLE audit_events ADD COLUMN operation TEXT;
