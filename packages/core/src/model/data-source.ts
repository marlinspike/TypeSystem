/**
 * DataSource = a connection-level enterprise system reference (e.g. an
 * in-memory repository, a mocked REST system, a Postgres instance).
 * Mapping = binds one Type's property/relationship/action to a DataSource
 * + adapter operation. Together these keep "what something IS" independent
 * from "where its data comes from" (see ADR-0006).
 */
export interface DataSource {
  id: string;
  name: string;
  kind: "in-memory" | "mock-rest" | "postgres" | string;
  config?: Record<string, unknown>;
}

export type MappingTarget = "property" | "relationship" | "action";
export type ResolutionMode = "live" | "materialized" | "cached";

export interface Mapping {
  id: string;
  typeName: string;
  target: MappingTarget;
  targetName: string;
  dataSourceId: string;
  operation: string;
  resolutionMode: ResolutionMode;
  /** Seam for multi-source conflict resolution; not exercised by the slice. */
  priority?: number;
  /** Only meaningful when `resolutionMode === "cached"`; falls back to the runtime's `defaultCacheTtlMs` (see ADR-0016). */
  cacheTtlMs?: number;
}
