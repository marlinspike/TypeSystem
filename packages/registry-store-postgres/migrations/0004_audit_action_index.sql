-- Audit rows of one action, newest first (ADR-0069): an install reads every
-- earlier `pack.install` row to check what is installed against revocations.
CREATE INDEX idx_audit_events_action ON audit_events (action, "timestamp" DESC, id DESC);
