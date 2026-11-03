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
  type SortKey,
  SourceRefusedError
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

  private async rows(typeName: string, sql: string, params: unknown[], signal?: AbortSignal): Promise<Record<string, unknown>[]> {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
    try {
      return (await this.pool.query<Record<string, unknown>>(sql, params)).rows;
    } catch (err) {
      throw this.readFailure(typeName, err);
    }
  }

  /**
   * What a failed read becomes (ADR-0110). A connection failure or a server
   * shutting down is the source being unavailable, and worth retrying. The
   * database refusing this connection the table is the source's own
   * refusal. A table or column the database does not have is the
   * deployment's mapping not matching the database: not retryable, and
   * named by Type and source, so the caller gets a problem that says where
   * to look instead of an internal error. The database's own message stays
   * in `cause`, for the server's log.
   */
  private readFailure(typeName: string, err: unknown): Error {
    const code = (err as { code?: string }).code;
    const system = this.config.system;
    // A socket error carries a Node code (ECONNREFUSED), not a five-character SQLSTATE: the server was never reached.
    if (code === undefined || !/^[0-9A-Z]{5}$/.test(code) || code.startsWith("08") || code.startsWith("57")) {
      return new AdapterUnavailableError(`${system} could not be read: ${(err as Error).message}`);
    }
    if (code === "42501") return new SourceRefusedError(`${system} refused TypeSystem's connection permission to read ${typeName}`, this.dataSourceId);
    if (code === "42P01" || code === "42703" || code === "3F000") {
      const failure = new AdapterUnavailableError(
        `${system} could not answer for ${typeName}: the deployment's mapping of it names a table or column the database does not have (typesys deploy build lists which)`,
        { retryable: false }
      );
      (failure as { cause?: unknown }).cause = err;
      return failure;
    }
    return err instanceof Error ? err : new Error(String(err));
  }

  /**
   * Every problem with this adapter's mapping that the database can see
   * (ADR-0110): a table or view that does not exist, an id or property
   * column it does not have, or a table this connection may not read. Each
   * names the Type, the property and, when one is close, the name probably
   * meant. Reads the catalog only, never a row. Rejects with
   * `AdapterUnavailableError` when the database cannot be reached, which is
   * not a mapping problem.
   */
  async checkMapping(): Promise<string[]> {
    const problems: string[] = [];
    for (const [type, m] of Object.entries(this.config.types)) {
      let rel: { oid: string | null; readable: boolean | null; schema: string | null } | undefined;
      try {
        [rel] = (
          await this.pool.query<{ oid: string | null; readable: boolean | null; schema: string | null }>(
            `SELECT to_regclass($1)::oid::text AS oid,
                    CASE WHEN to_regclass($1) IS NULL THEN NULL ELSE has_table_privilege(to_regclass($1), 'SELECT') END AS readable,
                    (SELECT n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = to_regclass($1)) AS schema`,
            [quoted(m.table)]
          )
        ).rows;
      } catch (err) {
        throw this.readFailure(type, err);
      }
      if (!rel?.oid) {
        const schema = m.table.includes(".") ? m.table.slice(0, m.table.indexOf(".")) : undefined;
        const names = (
          await this.pool.query<{ name: string }>(
            schema
              ? `SELECT n.nspname || '.' || c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r','v','m','p','f') AND n.nspname = $1`
              : `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r','v','m','p','f') AND n.nspname = ANY (current_schemas(false))`,
            schema ? [schema] : []
          )
        ).rows.map((r) => r.name);
        problems.push(`${type}: ${this.config.system} has no table or view "${m.table}"${hint(m.table, names)}`);
        continue;
      }
      if (rel.readable === false) problems.push(`${type}: the connection may not read ${m.table} (it lacks SELECT on it)`);
      const columns = (
        await this.pool.query<{ name: string }>(`SELECT attname AS name FROM pg_attribute WHERE attrelid = $1::oid AND attnum > 0 AND NOT attisdropped`, [rel.oid])
      ).rows.map((r) => r.name);
      const has = new Set(columns);
      if (!has.has(m.id)) problems.push(`${type}: ${m.table} has no id column "${m.id}"${hint(m.id, columns)}`);
      for (const [property, c] of Object.entries(m.columns)) {
        const column = columnOf(c).column;
        if (!has.has(column)) problems.push(`${type}.${property}: ${m.table} has no column "${column}"${hint(column, columns)}`);
      }
    }
    return problems;
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
    const [row] = await this.rows(typeName, `${this.select(m)} WHERE rtrim(${quoted(m.id)}::text) = $1 LIMIT 1`, [objectId], opts?.signal);
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
    const rows = await this.rows(typeName, sql, params, signal);
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

/** `(did you mean "x"?)` for the closest of `names`, when one is close: within a third of the name's length in edits. */
function hint(name: string, names: readonly string[]): string {
  const bare = (n: string) => n.slice(n.lastIndexOf(".") + 1).toLowerCase();
  let best: { n: string; d: number } | undefined;
  for (const n of names) {
    const d = distance(bare(name), bare(n));
    if (d <= Math.max(1, Math.floor(bare(name).length / 3)) && (!best || d < best.d)) best = { n, d };
  }
  return best ? ` (did you mean "${best.n}"?)` : "";
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length]!;
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
