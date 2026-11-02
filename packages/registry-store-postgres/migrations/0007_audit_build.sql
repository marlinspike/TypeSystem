-- The deployment build an audit row was written under (ADR-0101): the digest of
-- the deployment manifest the writing host was built from. Nullable and additive,
-- so a host built before it, still running during a rolling update, keeps writing.
ALTER TABLE audit_events ADD COLUMN build TEXT;
