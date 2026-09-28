-- A generic per-object-JSONB store: one row per (type_name, object_id), the
-- same shape every registered Type can use regardless of its own properties.
-- This is deliberately NOT a per-type table — a real production adapter for
-- ONE specific Type would normally get its own hand-designed table/columns;
-- this generic shape exists so the adapter proves the architecture against a
-- real database without requiring a bespoke schema per Type (see the package
-- README for when to graduate off this and write a Type-specific adapter
-- instead).

CREATE TABLE objects (
  type_name  TEXT NOT NULL,
  object_id  TEXT NOT NULL,
  values     JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (type_name, object_id)
);

-- Supports the "byForeignKey:<field>" relationship convention's pushdown
-- query (values ->> field = ...) without a full-table scan.
CREATE INDEX idx_objects_values ON objects USING GIN (values);
