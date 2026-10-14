-- audit_events is append-only against TRUNCATE too (pressure test P3-A1): the
-- row-level UPDATE and DELETE triggers do not fire for a TRUNCATE, which the
-- table's owner could otherwise run to empty the log. The table's owner can
-- still disable triggers, so the runtime should log in as a role that does
-- not own it (docs/how-to/use-postgres.md).
DROP TRIGGER IF EXISTS audit_events_no_truncate ON audit_events;
CREATE TRIGGER audit_events_no_truncate
  BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_audit_mutation();
