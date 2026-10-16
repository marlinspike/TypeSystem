import type { Pool } from "pg";
import {
  AdapterUnavailableError,
  applySort,
  matchesFilter,
  parseResolution,
  UnsupportedResolutionError,
  type ActionDefinition,
  type Adapter,
  type AdapterCallOptions,
  type AdapterQueryResult,
  type ProvenanceRef,
  type QueryFilter,
  type QueryOperator,
  type RelatedRef,
  type RelationshipDefinition,
  type ResolvedProperties,
  type SortKey
} from "@typesys/core";

/**
 * How a column's value becomes a property value. `date` and `date-time`
 * read the driver's `Date` as ISO text (`YYYY-MM-DD` for a date); `number`
 * reads PostgreSQL `numeric`, which the driver returns as text; `map`
 * translates the table's codes into the model's values, and a code it does
 * not list is left out rather than passed through.
 */
export interface PostgresColumn {
  readonly column: string;
  readonly as?: "text" | "date" | "date-time" | "number" | "integer" | "boolean" | "json";
  readonly map?: Readonly<Record<string, unknown>>;
}

/** How one Type maps onto one table or view. */
export interface PostgresTableMapping {
  /** `schema.table`, or a table on the search path. */
  readonly table: string;
  /** The column holding the object id: the table's key. */
  readonly id: string;
  /** Property name → column. */
  readonly columns: Readonly<Record<string, string | PostgresColumn>>;
}

export interface PostgresTableAdapterConfig {
  readonly dataSourceId: string;
  /** The system's name, as provenance reports it. */
  readonly system: string;
  readonly types: Readonly<Record<string, PostgresTableMapping>>;
  /** Most rows one query reads before refusing to answer from a partial list. Default 10,000. */
  readonly maxRows?: number;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_$]*$/;

/** A quoted identifier, or a quoted `schema.name`; anything else is refused when the adapter is built. */
function quoted(name: string): string {
  const parts = name.split(".");
  if (parts.length > 2 || parts.some((p) => !IDENT.test(p))) throw new TypeError(`"${name}" is not a table or column name`);
  return parts.map((p) => `"${p}"`).join(".");
}

const columnOf = (c: string | PostgresColumn): PostgresColumn => (typeof c === "string" ? { column: c } : c);

/**
 * An existing database's own tables as TypeSystem objects (ADR-0076): one
 * table or view per Type, a column per property, read with parameterized
 * SQL. Where `PostgresRepositoryAdapter` owns a generic store, this adapter
 * reads tables another system owns and never writes them. Every condition
 * is decided with `matchesFilter` after `eq` conditions on plain columns
 * narrow the rows in SQL, as `HttpAdapter` does with a service's filters.
 */
export class PostgresTableAdapter implements Adapter {
  readonly dataSourceId: string;

  constructor(
    private readonly pool: Pool,
    private readonly config: PostgresTableAdapterConfig
  ) {
    this.dataSourceId = config.dataSourceId;
    for (const [type, m] of Object.entries(config.types)) {
      try {
        quoted(m.table);
        quoted(m.id);
        for (const c of Object.values(m.columns)) quoted(columnOf(c).column);
      } catch (err) {
        throw new TypeError(`${type}: ${(err as Error).message}`, { cause: err });
      }
    }
  }

  private mapping(typeName: string): PostgresTableMapping {
    const m = this.config.types[typeName];
    if (!m) throw new Error(`PostgresTableAdapter "${this.dataSourceId}" has no mapping for type "${typeName}"`);
    return m;
  }

  private select(m: PostgresTableMapping): string {
    const cols = new Set([m.id, ...Object.values(m.columns).map((c) => columnOf(c).column)]);
    return `SELECT ${[...cols].map(quoted).join(", ")} FROM ${quoted(m.table)}`;
  }

  private async rows(sql: string, params: unknown[], signal?: AbortSignal): Promise<Record<string, unknown>[]> {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
    try {
      return (await this.pool.query<Record<string, unknown>>(sql, params)).rows;
    } catch (err) {
      const code = (err as { code?: string }).code;
      // A connection failure or a server shutting down is the source being unavailable; anything else is a mapping fault.
      if (code === undefined || code.startsWith("08") || code.startsWith("57")) {
        throw new AdapterUnavailableError(`${this.config.system} could not be read: ${(err as Error).message}`);
      }
      throw err;
    }
  }

  private canonical(m: PostgresTableMapping, row: Record<string, unknown>): { objectId: string; values: Record<string, unknown>; provenance: ProvenanceRef[] } | undefined {
    const id = row[m.id];
    if (typeof id !== "string" && typeof id !== "number" && typeof id !== "bigint") return undefined;
    // Trimmed as values are, so an id from a query is the id a read takes (`char(n)` pads it).
    const objectId = typeof id === "string" ? id.trimEnd() : String(id);
    const retrievedAt = new Date().toISOString();
    const values: Record<string, unknown> = {};
    const provenance: ProvenanceRef[] = [];
    for (const [name, c] of Object.entries(m.columns)) {
      const col = columnOf(c);
      const value = convert(row[col.column], col);
      if (value === undefined) continue;
      values[name] = value;
      provenance.push({ propertyPath: name, source: { dataSourceId: this.dataSourceId, system: this.config.system, recordId: objectId, field: `${m.table}.${col.column}` }, retrievedAt });
    }
    return { objectId, values, provenance };
  }

  async resolveProperties(typeName: string, objectId: string, _propertyNames: string[], opts?: AdapterCallOptions): Promise<ResolvedProperties> {
    const m = this.mapping(typeName);
    const [row] = await this.rows(`${this.select(m)} WHERE rtrim(${quoted(m.id)}::text) = $1 LIMIT 1`, [objectId], opts?.signal);
    const c = row ? this.canonical(m, row) : undefined;
    return c ? { values: c.values, provenance: c.provenance } : { values: {}, provenance: [] };
  }

  /** The rows matching the `eq` conditions SQL can decide exactly, canonical; at most `maxRows`. */
  private async list(typeName: string, filter: QueryFilter | undefined, signal?: AbortSignal) {
    const m = this.mapping(typeName);
    const where: string[] = [];
    const params: unknown[] = [];
    for (const c of pushable(filter)) {
      const spec = m.columns[c.property];
      // Only a column held as-is: a translated or converted value would be compared with the wrong one.
      if (typeof spec !== "string" || (typeof c.value !== "string" && typeof c.value !== "number" && typeof c.value !== "boolean")) continue;
      params.push(String(c.value));
      // As the value is returned: `char(n)` padding trimmed from the end, so `eq` finds what a read shows (M3 review L6).
      where.push(`rtrim(${quoted(spec)}::text) = $${params.length}`);
    }
    const max = this.config.maxRows ?? 10_000;
    const sql = `${this.select(m)}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY ${quoted(m.id)} LIMIT ${max + 1}`;
    const rows = await this.rows(sql, params, signal);
    // The caller's to narrow, not an outage: reading again would answer the same.
    if (rows.length > max) throw new AdapterUnavailableError(`${this.config.system} has more than ${max} rows of ${typeName} for this query; narrow it`, { retryable: false });
    return rows.map((r) => this.canonical(m, r)).filter((c): c is NonNullable<typeof c> => c !== undefined);
  }

  async queryByType(typeName: string, filter?: QueryFilter, limit?: number, cursor?: string, sort?: SortKey[], opts?: AdapterCallOptions): Promise<AdapterQueryResult> {
    const all = (await this.list(typeName, filter, opts?.signal)).filter((o) => matchesFilter(o.values, filter));
    const sorted = applySort(all, sort, (o) => o.values);
    const start = cursor === undefined ? 0 : Number(cursor);
    if (!Number.isInteger(start) || start < 0) throw new TypeError(`Invalid cursor "${cursor}"`);
    const end = limit === undefined ? sorted.length : start + limit;
    return { items: sorted.slice(start, end), ...(end < sorted.length ? { nextCursor: String(end) } : {}) };
  }

  /** Every condition is evaluated in `queryByType` with `matchesFilter` itself (ADR-0040). */
  canFilter(typeName: string, property: string, _operator: QueryOperator): boolean {
    return Object.hasOwn(this.mapping(typeName).columns, property);
  }

  async resolveRelationship(relationship: RelationshipDefinition, sourceObjectId: string, opts?: AdapterCallOptions): Promise<RelatedRef[]> {
    const strategy = parseResolution(relationship.resolution.operation);
    if (strategy.kind === "byForeignKey") {
      const filter: QueryFilter = { property: strategy.field, operator: "eq", value: sourceObjectId };
      return (await this.list(relationship.targetType, filter, opts?.signal)).filter((o) => matchesFilter(o.values, filter)).map((o) => ({ objectId: o.objectId }));
    }
    if (strategy.kind === "byOwnField") {
      const source = await this.resolveProperties(relationship.sourceType, sourceObjectId, [strategy.field], opts);
      const id = source.values[strategy.field];
      return typeof id === "string" || typeof id === "number" ? [{ objectId: String(id) }] : [];
    }
    throw new UnsupportedResolutionError(`PostgresTableAdapter supports byForeignKey and byOwnField relationships, not "${strategy.kind}"`);
  }

  executeAction(action: ActionDefinition): Promise<unknown> {
    return Promise.reject(new Error(`PostgresTableAdapter "${this.dataSourceId}" reads tables another system owns and implements no Actions (asked for ${action.name})`));
  }
}

function convert(raw: unknown, col: PostgresColumn): unknown {
  if (raw === null || raw === undefined) return undefined;
  if (col.map) return typeof raw === "string" && Object.hasOwn(col.map, raw.trim()) ? col.map[raw.trim()] : undefined;
  switch (col.as) {
    case "date":
      return raw instanceof Date ? isoDate(raw) : typeof raw === "string" ? raw : JSON.stringify(raw);
    case "date-time":
      return raw instanceof Date ? raw.toISOString() : typeof raw === "string" ? raw : JSON.stringify(raw);
    case "number":
    case "integer": {
      const n = typeof raw === "number" ? raw : Number(raw);
      return Number.isFinite(n) ? n : undefined;
    }
    case "boolean":
      return typeof raw === "boolean" ? raw : undefined;
    case "json":
      return raw;
    default:
      // `char(n)` pads with spaces the model never meant.
      return typeof raw === "string" ? raw.trimEnd() : raw instanceof Date ? raw.toISOString() : raw;
  }
}

/** The calendar date the driver read, in the server's local zone as the driver built it. */
function isoDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** The `eq` conditions a filter requires of every match: the top level, or every member of an `and`. */
function pushable(filter: QueryFilter | undefined): { property: string; value: unknown }[] {
  if (!filter) return [];
  if ("and" in filter) return filter.and.flatMap(pushable);
  if ("or" in filter) return [];
  return filter.operator === "eq" ? [{ property: filter.property, value: filter.value }] : [];
}
