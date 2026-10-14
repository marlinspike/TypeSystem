-- The journal's integrity, past UPDATE and DELETE of single events (ADR-0066).
-- Events: TRUNCATE is refused too. Runs: a row starts empty and unfinished;
-- afterwards its length is always the number of its events, and it is
-- finished only once its events hold a run-finished event; it is never
-- deleted or truncated. A run marked finished behind the journal's back would
-- drop out of unfinished(), and a deadline on it would never fire.
DROP TRIGGER IF EXISTS typesys_workflow_events_no_truncate ON typesys_workflow_events;
CREATE TRIGGER typesys_workflow_events_no_truncate
  BEFORE TRUNCATE ON typesys_workflow_events
  FOR EACH STATEMENT EXECUTE FUNCTION typesys_workflow_events_append_only();

CREATE OR REPLACE FUNCTION typesys_workflow_runs_follow_events() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.length <> 0 OR NEW.finished THEN
      RAISE EXCEPTION 'typesys_workflow_runs: a run starts with no events, unfinished';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'typesys_workflow_runs: % is not permitted; runs are the journal''s index', TG_OP;
  END IF;
  IF NEW.run_id <> OLD.run_id THEN
    RAISE EXCEPTION 'typesys_workflow_runs: a run id does not change';
  END IF;
  IF NEW.length <> (SELECT count(*) FROM typesys_workflow_events WHERE run_id = NEW.run_id) THEN
    RAISE EXCEPTION 'typesys_workflow_runs: a run''s length is the number of its events';
  END IF;
  IF OLD.finished AND NOT NEW.finished THEN
    RAISE EXCEPTION 'typesys_workflow_runs: a finished run stays finished';
  END IF;
  IF NEW.finished AND NOT OLD.finished AND NOT EXISTS (
    SELECT 1 FROM typesys_workflow_events WHERE run_id = NEW.run_id AND event->>'type' = 'run-finished'
  ) THEN
    RAISE EXCEPTION 'typesys_workflow_runs: a run is finished only by a run-finished event';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS typesys_workflow_runs_integrity ON typesys_workflow_runs;
CREATE TRIGGER typesys_workflow_runs_integrity
  BEFORE INSERT OR UPDATE OR DELETE ON typesys_workflow_runs
  FOR EACH ROW EXECUTE FUNCTION typesys_workflow_runs_follow_events();

DROP TRIGGER IF EXISTS typesys_workflow_runs_no_truncate ON typesys_workflow_runs;
CREATE TRIGGER typesys_workflow_runs_no_truncate
  BEFORE TRUNCATE ON typesys_workflow_runs
  FOR EACH STATEMENT EXECUTE FUNCTION typesys_workflow_events_append_only();
