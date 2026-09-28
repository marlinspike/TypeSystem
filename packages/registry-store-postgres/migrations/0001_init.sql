-- TypeS registry store schema (see docs/adr/0015-postgres-registry-store.md).
-- Applied by the migration runner in src/migrate.ts, tracked in schema_migrations.
-- Never applied automatically by PostgresRegistryStore itself.

CREATE TABLE types (
  id                 TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  version             TEXT NOT NULL,
  extends             TEXT,
  traits              JSONB NOT NULL DEFAULT '[]',
  description         TEXT,
  schema              JSONB NOT NULL,
  action_names        JSONB NOT NULL DEFAULT '[]',
  computed_properties JSONB NOT NULL DEFAULT '[]',
  deprecated          JSONB,
  aliases             JSONB,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (name, version)
);
CREATE INDEX idx_types_name ON types (name);

CREATE TABLE relationships (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  source_type  TEXT NOT NULL,
  target_type  TEXT NOT NULL,
  cardinality  TEXT NOT NULL CHECK (cardinality IN ('one-to-one', 'one-to-many', 'many-to-many')),
  inverse_name TEXT,
  edge_schema  JSONB,
  resolution   JSONB NOT NULL,
  version      TEXT NOT NULL,
  deprecated   JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Upserted by (source_type, name): "current relationships for this type,"
  -- never versioned history — see ADR-0015 "Alternatives Considered."
  UNIQUE (source_type, name)
);
CREATE INDEX idx_relationships_source_type ON relationships (source_type);

CREATE TABLE actions (
  id                   TEXT PRIMARY KEY,
  name                 TEXT NOT NULL,
  version              TEXT NOT NULL,
  description          TEXT NOT NULL,
  applicable_types     JSONB NOT NULL,
  input_schema         JSONB NOT NULL,
  output_schema        JSONB NOT NULL,
  authorization_policy TEXT NOT NULL,
  preconditions        JSONB NOT NULL DEFAULT '[]',
  implementation       JSONB NOT NULL,
  side_effects         TEXT NOT NULL CHECK (side_effects IN ('none', 'creates', 'mutates', 'external')),
  idempotency          TEXT NOT NULL CHECK (idempotency IN ('none', 'key', 'natural')),
  audit_required       BOOLEAN NOT NULL,
  deprecated           JSONB,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (name, version)
);
CREATE INDEX idx_actions_name ON actions (name);

CREATE TABLE data_sources (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL,
  config     JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE mappings (
  id              TEXT PRIMARY KEY,
  type_name       TEXT NOT NULL,
  target          TEXT NOT NULL CHECK (target IN ('property', 'relationship', 'action')),
  target_name     TEXT NOT NULL,
  data_source_id  TEXT NOT NULL REFERENCES data_sources (id),
  operation       TEXT NOT NULL,
  resolution_mode TEXT NOT NULL CHECK (resolution_mode IN ('live', 'materialized', 'cached')),
  priority        INTEGER,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
  -- Deliberately no UNIQUE(type_name, target, target_name): a wildcard ("*")
  -- mapping may legitimately coexist with a more specific one, and multiple
  -- candidate mappings per (type, target, targetName) support source-priority
  -- conflict resolution (Mapping.priority) — see ADR-0015.
);
CREATE INDEX idx_mappings_type_name ON mappings (type_name);

CREATE TABLE audit_events (
  id                     TEXT PRIMARY KEY,
  "timestamp"            TIMESTAMPTZ NOT NULL DEFAULT now(),
  subject_id             TEXT NOT NULL,
  action                 TEXT NOT NULL,
  resource_type_name     TEXT NOT NULL,
  resource_object_id     TEXT,
  resource_property_path TEXT,
  decision               TEXT NOT NULL CHECK (decision IN ('allow', 'deny')),
  reason                 TEXT,
  outcome                TEXT CHECK (outcome IN ('success', 'failure')),
  details                JSONB
);
CREATE INDEX idx_audit_events_timestamp ON audit_events ("timestamp" DESC);
CREATE INDEX idx_audit_events_subject ON audit_events (subject_id);

-- Immutable security events (mission brief, "Security"): no application
-- bug or compromised app-level credential can edit or delete an audit row.
CREATE OR REPLACE FUNCTION prevent_audit_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_events_no_update
  BEFORE UPDATE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_mutation();

CREATE TRIGGER audit_events_no_delete
  BEFORE DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_mutation();
