-- TypeSys workflow journal (docs/adr/0066-durable-execution-on-the-journal-seam.md).
-- One row per run (its length, and whether it finished) and one row per event.
-- Events are append-only: a trigger refuses UPDATE and DELETE, because the
-- journal is the run's only state and its evidence.
CREATE TABLE IF NOT EXISTS typesys_workflow_runs (
  run_id     TEXT PRIMARY KEY,
  length     INTEGER NOT NULL,
  finished   BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS typesys_workflow_runs_unfinished ON typesys_workflow_runs (run_id) WHERE NOT finished;

CREATE TABLE IF NOT EXISTS typesys_workflow_events (
  run_id TEXT NOT NULL REFERENCES typesys_workflow_runs (run_id),
  seq    INTEGER NOT NULL,
  at     TEXT NOT NULL,
  event  JSONB NOT NULL,
  PRIMARY KEY (run_id, seq)
);

CREATE OR REPLACE FUNCTION typesys_workflow_events_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'typesys_workflow_events is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS typesys_workflow_events_no_change ON typesys_workflow_events;
CREATE TRIGGER typesys_workflow_events_no_change
  BEFORE UPDATE OR DELETE ON typesys_workflow_events
  FOR EACH ROW EXECUTE FUNCTION typesys_workflow_events_append_only();
