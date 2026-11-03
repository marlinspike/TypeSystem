-- A verifiable audit trail (ADR-0105). Each row a chained writer appends names
-- its writer's chain, its place in it, the hash of the row before it and its
-- own hash. Rows written before this migration have none, and verify reports
-- them as unchained. Nullable and additive: a host built before it, still
-- running during a rolling update, keeps writing.
ALTER TABLE audit_events ADD COLUMN chain TEXT;
ALTER TABLE audit_events ADD COLUMN seq BIGINT;
ALTER TABLE audit_events ADD COLUMN prev_hash TEXT;
ALTER TABLE audit_events ADD COLUMN hash TEXT;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_chain_link
  CHECK ((chain IS NULL AND seq IS NULL AND prev_hash IS NULL AND hash IS NULL)
      OR (chain IS NOT NULL AND seq >= 1 AND prev_hash IS NOT NULL AND hash IS NOT NULL));
CREATE UNIQUE INDEX audit_events_chain_seq ON audit_events (chain, seq) WHERE chain IS NOT NULL;

-- Signed chain heads: what lets a verifier tell a chain cut short from one
-- that ended. Append-only like the rows they sign.
CREATE TABLE audit_checkpoints (
  chain     TEXT NOT NULL,
  seq       BIGINT NOT NULL CHECK (seq >= 0), -- 0: the opening checkpoint, signing the genesis hash
  hash      TEXT NOT NULL,
  at        TEXT NOT NULL,
  key_id    TEXT NOT NULL,
  signature TEXT NOT NULL,
  PRIMARY KEY (chain, seq)
);
CREATE TRIGGER audit_checkpoints_no_update BEFORE UPDATE ON audit_checkpoints FOR EACH ROW EXECUTE FUNCTION prevent_audit_mutation();
CREATE TRIGGER audit_checkpoints_no_delete BEFORE DELETE ON audit_checkpoints FOR EACH ROW EXECUTE FUNCTION prevent_audit_mutation();
CREATE TRIGGER audit_checkpoints_no_truncate BEFORE TRUNCATE ON audit_checkpoints FOR EACH STATEMENT EXECUTE FUNCTION prevent_audit_mutation();

-- Retention (ADR-0105): a row may be deleted only by a prune (the session sets
-- typesys.audit_prune), only if it is chained, and only if a checkpoint of its
-- chain covers it, so what remains still verifies from that checkpoint. This
-- keeps a bug or a stolen application credential from deleting unanchored
-- rows; it is not what makes the trail tamper-evident (the chain is).
CREATE OR REPLACE FUNCTION guard_audit_delete() RETURNS trigger AS $$
BEGIN
  IF coalesce(current_setting('typesys.audit_prune', true), '') = 'on'
     AND OLD.chain IS NOT NULL
     AND EXISTS (SELECT 1 FROM audit_checkpoints c WHERE c.chain = OLD.chain AND c.seq >= OLD.seq) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_events is append-only: DELETE is permitted only to prune checkpointed rows';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS audit_events_no_delete ON audit_events;
CREATE TRIGGER audit_events_no_delete BEFORE DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION guard_audit_delete();
