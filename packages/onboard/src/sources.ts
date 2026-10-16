import { createHash } from "node:crypto";
import { canonical, type JsonSchema2020 } from "@typesys/core";
import type { PostgresColumn } from "@typesys/adapter-postgres";

/**
 * What onboarding knows about a source, and nothing else (ADR-0076). Every
 * fact is one `Evidence` record with a stable id; everything proposed later
 * (a Type, a property, a relationship, a sensitive field, an Action, a
 * finding) cites the records it rests on, and a citation of an id that is
 * not here is refused. Onboarding reads metadata only: catalog entries,
 * contracts and schemas, never a row or a response body.
 */
export interface Evidence {
  readonly id: string;
  readonly source: string;
  /** The fact, in one line, as the reviewer and the model read it. */
  readonly text: string;
}

export type SourceKind = "postgres" | "openapi" | "json-schema";

export interface SourceInfo {
  readonly id: string;
  readonly kind: SourceKind;
  /** The system's own name, as provenance will report it. */
  readonly system: string;
  readonly description?: string;
  /** sha256 of the canonical metadata the evidence was drawn from: a later run compares it. */
  readonly digest: string;
}

/** Why a field may need protecting, found in its name or its documentation. */
export type SensitivityCategory = "personal-name" | "government-id" | "contact" | "date-of-birth" | "health" | "financial" | "location" | "credential" | "classified" | "personal";

export interface SensitivityHint {
  readonly category: SensitivityCategory;
  /** A classification marking stated in the documentation (`SECRET`), for `classified`. */
  readonly marking?: string;
  readonly reason: string;
}

export interface SourceField {
  /** Evidence id. */
  readonly id: string;
  /** The source's own name: a column, or a JSON property. */
  readonly name: string;
  /** For an API record, the JSON Pointer to the value. */
  readonly pointer?: string;
  readonly schema: JsonSchema2020;
  readonly nullable: boolean;
  readonly required: boolean;
  readonly description?: string;
  /** For a column, its SQL type, and how the table adapter converts it. */
  readonly storage?: string;
  readonly as?: PostgresColumn["as"];
  /** A reference the source itself declares (a foreign key). */
  readonly references?: { readonly entity: string; readonly field: string; readonly evidence: string };
  readonly hints: readonly SensitivityHint[];
}

export interface SourceEntity {
  /** Evidence id. */
  readonly id: string;
  readonly source: string;
  /** The source's own name: `schema.table`, or a component schema's name. */
  readonly name: string;
  readonly description?: string;
  /** The field holding each record's identity, when the source says which. */
  readonly key?: string;
  readonly fields: readonly SourceField[];
}

export type OperationRole = "get" | "list" | "command";

export interface SourceOperation {
  /** Evidence id. */
  readonly id: string;
  readonly source: string;
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
  readonly operationId?: string;
  readonly summary?: string;
  readonly role: OperationRole;
  /** The entity a get or list returns, or a command acts on (by its path parameter). */
  readonly entity?: string;
  readonly pathParams: readonly string[];
  /** Query parameters, with the entity field each one filters on when its name matches. */
  readonly queryParams: readonly { readonly name: string; readonly field?: string }[];
  /** For a list, the pointer to the array of records in its response. */
  readonly items?: string;
  /** For a command, its JSON request body. */
  readonly body?: JsonSchema2020;
  readonly scopes: readonly string[];
}

/** How the source authenticates callers, as its contract says (never a credential). */
export interface SourceAuth {
  readonly kind: "client-credentials" | "api-key" | "none";
  readonly tokenUrl?: string;
  readonly header?: string;
  readonly scopes?: readonly string[];
}

/** One source, collected: its own metadata, as evidence. */
export interface CollectedSource {
  readonly info: SourceInfo;
  readonly entities: readonly SourceEntity[];
  readonly operations: readonly SourceOperation[];
  readonly auth?: SourceAuth;
  readonly evidence: readonly Evidence[];
}

/** Every source being onboarded together. */
export interface SourceModel {
  readonly sources: readonly CollectedSource[];
  readonly evidence: ReadonlyMap<string, Evidence>;
  entity(id: string): SourceEntity | undefined;
  field(id: string): { entity: SourceEntity; field: SourceField } | undefined;
  operation(id: string): SourceOperation | undefined;
}

/** The sources as one model, with every evidence id unique. */
export function sourceModel(sources: readonly CollectedSource[]): SourceModel {
  const evidence = new Map<string, Evidence>();
  const ids = new Set<string>();
  for (const s of sources) {
    if (ids.has(s.info.id)) throw new Error(`Two sources are named "${s.info.id}"`);
    ids.add(s.info.id);
    for (const e of s.evidence) {
      if (evidence.has(e.id)) throw new Error(`Evidence id "${e.id}" is not unique`);
      evidence.set(e.id, e);
    }
  }
  const entities = new Map(sources.flatMap((s) => s.entities.map((e) => [e.id, e] as const)));
  const fields = new Map(sources.flatMap((s) => s.entities.flatMap((e) => e.fields.map((f) => [f.id, { entity: e, field: f }] as const))));
  const operations = new Map(sources.flatMap((s) => s.operations.map((o) => [o.id, o] as const)));
  return {
    sources,
    evidence,
    entity: (id) => entities.get(id),
    field: (id) => fields.get(id),
    operation: (id) => operations.get(id)
  };
}

export const digestOf = (value: unknown): string => `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;

// ---------------------------------------------------------------- sensitivity

const words = (text: string): string[] =>
  text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

const NAME_RULES: readonly { readonly match: (w: string[]) => boolean; readonly category: SensitivityCategory; readonly reason: string }[] = [
  { match: (w) => w.includes("ssn") || (w.includes("social") && w.includes("security")), category: "government-id", reason: "the name says it holds a social security number" },
  { match: (w) => w.includes("passport") || w.includes("dodid") || w.includes("edipi"), category: "government-id", reason: "the name says it holds a government identifier" },
  { match: (w) => w.includes("dob") || (w.includes("birth") && (w.includes("date") || w.includes("dt"))), category: "date-of-birth", reason: "the name says it holds a date of birth" },
  { match: (w) => ["phone", "email", "mobile", "addr", "address"].some((x) => w.includes(x)), category: "contact", reason: "the name says it holds contact details" },
  { match: (w) => ((w.includes("first") || w.includes("last") || w.includes("full") || w.includes("middle")) && (w.includes("name") || w.includes("nm"))) || w.join(" ") === "name", category: "personal-name", reason: "the name says it holds a person's name" },
  { match: (w) => ["password", "passwd", "secret", "token", "apikey"].some((x) => w.includes(x)) || (w.includes("api") && w.includes("key")), category: "credential", reason: "the name says it holds a credential" },
  { match: (w) => ["salary", "pay", "iban", "account"].some((x) => w.includes(x)), category: "financial", reason: "the name says it holds financial data" },
  { match: (w) => ["diagnosis", "medical", "health"].some((x) => w.includes(x)), category: "health", reason: "the name says it holds health data" }
];

const MARKINGS = ["TOP SECRET", "SECRET", "CONFIDENTIAL", "CUI"];

/** What a field's name and documentation say about its sensitivity. Deterministic, and only ever adds protection. */
export function sensitivityHints(name: string, description: string | undefined): SensitivityHint[] {
  const out: SensitivityHint[] = [];
  const w = words(name);
  for (const r of NAME_RULES) if (r.match(w)) out.push({ category: r.category, reason: r.reason });
  const doc = description ?? "";
  if (/\bclassified\b/i.test(doc) || MARKINGS.some((m) => new RegExp(`\\b${m}\\b`).test(doc))) {
    const marking = MARKINGS.find((m) => new RegExp(`\\b${m}\\b`).test(doc));
    out.push({ category: "classified", ...(marking ? { marking } : {}), reason: `its documentation says it is classified${marking ? ` ${marking}` : ""}` });
  }
  if (/\b(personal data|personally identifiable|pii)\b/i.test(doc)) out.push({ category: "personal", reason: "its documentation says it is personal data" });
  const seen = new Set<string>();
  return out.filter((h) => (seen.has(h.category) ? false : (seen.add(h.category), true)));
}

// ------------------------------------------------------------------ postgres

/** A PostgreSQL catalog, as `introspectPostgres` reads it or a snapshot holds it. */
export interface PgCatalog {
  readonly database: string;
  readonly schemas: readonly { readonly name: string; readonly comment?: string }[];
  readonly tables: readonly PgTable[];
  readonly enums: readonly { readonly schema: string; readonly name: string; readonly values: readonly string[] }[];
}

export interface PgTable {
  readonly schema: string;
  readonly name: string;
  readonly kind: "table" | "view";
  readonly comment?: string;
  readonly columns: readonly PgColumn[];
  readonly primaryKey?: readonly string[];
  readonly foreignKeys: readonly { readonly name: string; readonly columns: readonly string[]; readonly references: { readonly schema: string; readonly table: string; readonly columns: readonly string[] } }[];
  readonly checks: readonly { readonly name: string; readonly columns: readonly string[]; readonly definition: string }[];
  readonly unique: readonly (readonly string[])[];
}

export interface PgColumn {
  readonly name: string;
  /** `format_type`: `character varying(9)`, `numeric(8,1)`, `mx.evt_typ`. */
  readonly type: string;
  /** The type's own name and schema (`varchar`, `pg_catalog`), and whether it is an enum. */
  readonly udt: string;
  readonly udtSchema: string;
  readonly isEnum: boolean;
  readonly notNull: boolean;
  readonly default?: string;
  readonly comment?: string;
}

/** Anything that runs a parameterized query, as `pg`'s `Pool` and `Client` do. */
export interface Queryable {
  query<R extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

/**
 * Reads the catalog of `schemas` from a live database: tables, views,
 * columns with their types and comments, keys, foreign keys, check
 * constraints and enum types. It reads `pg_catalog` only, never a table's
 * rows, so it needs no access to the data.
 */
export async function introspectPostgres(db: Queryable, schemas: readonly string[]): Promise<PgCatalog> {
  const s = [...schemas];
  const [{ rows: dbRows }, { rows: ns }, { rows: rels }, { rows: cols }, { rows: cons }, { rows: enums }] = await Promise.all([
    db.query<{ name: string }>(`SELECT current_database() AS name`),
    db.query<{ name: string; comment: string | null }>(`SELECT nspname AS name, obj_description(oid, 'pg_namespace') AS comment FROM pg_namespace WHERE nspname = ANY($1) ORDER BY 1`, [s]),
    db.query<{ schema: string; name: string; kind: string; comment: string | null }>(
      `SELECT n.nspname AS schema, c.relname AS name, c.relkind AS kind, obj_description(c.oid, 'pg_class') AS comment
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = ANY($1) AND c.relkind IN ('r', 'p', 'v', 'm') ORDER BY 1, 2`,
      [s]
    ),
    db.query<{ schema: string; table: string; name: string; type: string; udt: string; udt_schema: string; typtype: string; not_null: boolean; default: string | null; comment: string | null }>(
      `SELECT n.nspname AS schema, c.relname AS table, a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
              t.typname AS udt, tn.nspname AS udt_schema, t.typtype AS typtype, a.attnotnull AS not_null,
              pg_get_expr(d.adbin, d.adrelid) AS default, col_description(c.oid, a.attnum) AS comment
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_type t ON t.oid = a.atttypid JOIN pg_namespace tn ON tn.oid = t.typnamespace
         LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE n.nspname = ANY($1) AND c.relkind IN ('r', 'p', 'v', 'm') AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY 1, 2, a.attnum`,
      [s]
    ),
    db.query<{ schema: string; table: string; name: string; type: string; definition: string; columns: string[]; ref_schema: string | null; ref_table: string | null; ref_columns: string[] | null }>(
      `SELECT n.nspname AS schema, c.relname AS table, con.conname AS name, con.contype AS type, pg_get_constraintdef(con.oid) AS definition,
              ARRAY(SELECT a.attname FROM unnest(con.conkey) WITH ORDINALITY k(n, i) JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.n ORDER BY k.i)::text[] AS columns,
              rn.nspname AS ref_schema, rc.relname AS ref_table,
              ARRAY(SELECT a.attname FROM unnest(con.confkey) WITH ORDINALITY k(n, i) JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.n ORDER BY k.i)::text[] AS ref_columns
         FROM pg_constraint con
         JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_class rc ON rc.oid = con.confrelid LEFT JOIN pg_namespace rn ON rn.oid = rc.relnamespace
        WHERE n.nspname = ANY($1) AND con.contype IN ('p', 'f', 'u', 'c')
        ORDER BY 1, 2, 3`,
      [s]
    ),
    db.query<{ schema: string; name: string; values: string[] }>(
      `SELECT n.nspname AS schema, t.typname AS name, ARRAY(SELECT e.enumlabel FROM pg_enum e WHERE e.enumtypid = t.oid ORDER BY e.enumsortorder)::text[] AS values
         FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = ANY($1) AND t.typtype = 'e' ORDER BY 1, 2`,
      [s]
    )
  ]);
  const opt = (v: string | null | undefined) => (v === null || v === undefined || v === "" ? {} : undefined);
  const tables: PgTable[] = rels.map((r) => {
    const mine = cons.filter((c) => c.schema === r.schema && c.table === r.name);
    const pk = mine.find((c) => c.type === "p");
    return {
      schema: r.schema,
      name: r.name,
      kind: r.kind === "v" || r.kind === "m" ? "view" : "table",
      ...(opt(r.comment) ?? { comment: r.comment! }),
      columns: cols
        .filter((c) => c.schema === r.schema && c.table === r.name)
        .map((c) => ({
          name: c.name,
          type: c.type,
          udt: c.udt,
          udtSchema: c.udt_schema,
          isEnum: c.typtype === "e",
          notNull: c.not_null,
          ...(opt(c.default) ?? { default: c.default! }),
          ...(opt(c.comment) ?? { comment: c.comment! })
        })),
      ...(pk ? { primaryKey: pk.columns } : {}),
      foreignKeys: mine
        .filter((c) => c.type === "f" && c.ref_schema && c.ref_table)
        .map((c) => ({ name: c.name, columns: c.columns, references: { schema: c.ref_schema!, table: c.ref_table!, columns: c.ref_columns ?? [] } })),
      checks: mine.filter((c) => c.type === "c").map((c) => ({ name: c.name, columns: c.columns, definition: c.definition })),
      unique: mine.filter((c) => c.type === "u").map((c) => c.columns)
    };
  });
  return {
    database: dbRows[0]?.name ?? "postgres",
    schemas: ns.map((n) => ({ name: n.name, ...(opt(n.comment) ?? { comment: n.comment! }) })),
    tables,
    enums: enums.map((e) => ({ schema: e.schema, name: e.name, values: e.values }))
  };
}

/** The values a single-column `CHECK (col = ANY (ARRAY[...]))` or `CHECK (col IN (...))` allows; undefined for any other check. */
export function checkValues(definition: string): (string | number)[] | undefined {
  const m = /= ANY \(\(?ARRAY\[(.*?)\]\)?(?:::[\w\s[\]."]+)?\)/.exec(definition) ?? /\bIN \((.*)\)\)?\s*$/.exec(definition);
  if (!m) return undefined;
  const out: (string | number)[] = [];
  for (const part of m[1]!.split(/,(?=(?:[^']*'[^']*')*[^']*$)/)) {
    const t = part.trim();
    const str = /^\(?'((?:[^']|'')*)'(?:::[\w\s."]+)?\)?$/.exec(t);
    if (str) out.push(str[1]!.replace(/''/g, "'"));
    else if (/^-?\d+(\.\d+)?$/.test(t)) out.push(Number(t));
    else return undefined;
  }
  return out.length ? out : undefined;
}

/** A column's value as JSON Schema, and how the table adapter converts it. */
function columnSchema(c: PgColumn, enums: PgCatalog["enums"]): { schema: JsonSchema2020; as?: PostgresColumn["as"]; unknown?: true } {
  if (c.isEnum) {
    const e = enums.find((x) => x.schema === c.udtSchema && x.name === c.udt);
    return { schema: { type: "string", ...(e ? { enum: [...e.values] } : {}) } };
  }
  const len = /\((\d+)\)$/.exec(c.type)?.[1];
  switch (c.udt) {
    case "varchar":
    case "bpchar":
    case "text":
    case "citext":
    case "name":
      return { schema: { type: "string", ...(len && c.udt !== "text" ? { maxLength: Number(len) } : {}) } };
    case "int2":
    case "int4":
      return { schema: { type: "integer" } };
    case "int8":
      return { schema: { type: "integer" }, as: "integer" };
    case "numeric":
      return { schema: { type: "number" }, as: "number" };
    case "float4":
    case "float8":
      return { schema: { type: "number" } };
    case "bool":
      return { schema: { type: "boolean" } };
    case "date":
      return { schema: { type: "string", format: "date" }, as: "date" };
    case "timestamp":
    case "timestamptz":
      return { schema: { type: "string", format: "date-time" }, as: "date-time" };
    case "uuid":
      return { schema: { type: "string", format: "uuid" } };
    case "json":
    case "jsonb":
      return { schema: {}, as: "json" };
    default:
      return { schema: { type: "string" }, unknown: true };
  }
}

const tableName = (schema: string, name: string) => `${schema}.${name}`;

/** A PostgreSQL catalog as evidence. `source` names it (`mxdb`); evidence ids are `pg:<source>/<schema>.<table>[.<column>]`. */
export function fromPostgres(catalog: PgCatalog, options: { readonly source: string; readonly system?: string }): CollectedSource {
  const source = options.source;
  const evidence: Evidence[] = [];
  const add = (id: string, text: string) => evidence.push({ id, source, text });
  const tableId = (schema: string, name: string) => `pg:${source}/${tableName(schema, name)}`;
  const description = catalog.schemas.map((s) => s.comment).find(Boolean);
  for (const sc of catalog.schemas) if (sc.comment) add(`pg:${source}/${sc.name}`, `Schema ${sc.name}: "${sc.comment}"`);
  for (const e of catalog.enums) add(`pg:${source}/type:${e.schema}.${e.name}`, `Enum type ${e.schema}.${e.name} has values ${e.values.map((v) => `'${v}'`).join(", ")}`);

  const entities: SourceEntity[] = catalog.tables.map((t) => {
    const id = tableId(t.schema, t.name);
    const pk = t.primaryKey?.length === 1 ? t.primaryKey[0] : undefined;
    add(id, `${t.kind === "view" ? "View" : "Table"} ${tableName(t.schema, t.name)}${t.comment ? `: "${t.comment}"` : " (no comment)"}${t.primaryKey ? `; primary key (${t.primaryKey.join(", ")})` : "; no primary key"}`);
    const fields: SourceField[] = t.columns.map((c) => {
      const fid = `${id}.${c.name}`;
      const { schema, as, unknown } = columnSchema(c, catalog.enums);
      const checks = t.checks.filter((k) => k.columns.length === 1 && k.columns[0] === c.name);
      let enumValues: (string | number)[] | undefined;
      for (const k of checks) {
        const v = checkValues(k.definition);
        add(`${id}#check:${k.name}`, `Check constraint ${k.name} on ${tableName(t.schema, t.name)}: ${k.definition}`);
        if (v) enumValues = v;
      }
      const fk = t.foreignKeys.find((f) => f.columns.length === 1 && f.columns[0] === c.name);
      const references = fk ? { entity: tableId(fk.references.schema, fk.references.table), field: `${tableId(fk.references.schema, fk.references.table)}.${fk.references.columns[0]}`, evidence: `${id}#fk:${fk.name}` } : undefined;
      if (fk) add(references!.evidence, `Foreign key ${fk.name}: ${tableName(t.schema, t.name)}.${c.name} references ${tableName(fk.references.schema, fk.references.table)}.${fk.references.columns[0]}`);
      add(
        fid,
        `Column ${tableName(t.schema, t.name)}.${c.name} ${c.type}${c.notNull ? " NOT NULL" : ""}${c.name === pk ? " PRIMARY KEY" : ""}${c.default ? ` DEFAULT ${c.default}` : ""}${c.comment ? `: "${c.comment}"` : ""}`
      );
      const full: JsonSchema2020 = enumValues ? { ...schema, enum: enumValues } : schema;
      return {
        id: fid,
        name: c.name,
        schema: full,
        nullable: !c.notNull,
        required: c.notNull,
        ...(c.comment ? { description: c.comment } : {}),
        storage: c.type,
        ...(as ? { as } : {}),
        ...(references ? { references } : {}),
        hints: [...sensitivityHints(c.name, c.comment), ...(unknown ? [] : [])]
      };
    });
    return { id, source, name: tableName(t.schema, t.name), ...(t.comment ? { description: t.comment } : {}), ...(pk ? { key: pk } : {}), fields };
  });
  return {
    info: { id: source, kind: "postgres", system: options.system ?? catalog.database, ...(description ? { description } : {}), digest: digestOf({ schemas: catalog.schemas, tables: catalog.tables, enums: catalog.enums }) },
    entities,
    operations: [],
    evidence
  };
}

// ------------------------------------------------------------------- openapi

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);
const esc = (s: string) => s.replace(/~/g, "~0").replace(/\//g, "~1");

/** A local `$ref` resolved within `doc`; anything else is returned as it is. */
function deref(doc: Json, v: unknown, depth = 0): unknown {
  if (!isObj(v) || typeof v.$ref !== "string" || depth > 16) return v;
  const ref = v.$ref;
  if (!ref.startsWith("#/")) return v;
  let cur: unknown = doc;
  for (const p of ref.slice(2).split("/")) cur = isObj(cur) ? cur[p.replace(/~1/g, "/").replace(/~0/g, "~")] : undefined;
  return deref(doc, cur, depth + 1);
}

/** A JSON Schema with every local `$ref` inlined, and OpenAPI 3.0's `nullable` as a type union. */
function inline(doc: Json, v: unknown, depth = 0): JsonSchema2020 {
  const s = deref(doc, v);
  if (!isObj(s) || depth > 8) return {};
  const out: Json = {};
  for (const [k, val] of Object.entries(s)) {
    if (k === "properties" && isObj(val)) out.properties = Object.fromEntries(Object.entries(val).map(([pk, pv]) => [pk, inline(doc, pv, depth + 1)]));
    else if (k === "items") out.items = inline(doc, val, depth + 1);
    else if (k === "nullable" || k === "example" || k === "examples" || k === "xml" || k === "externalDocs") continue;
    else out[k] = val;
  }
  if (s.nullable === true && typeof out.type === "string") out.type = [out.type, "null"];
  return out;
}

const refName = (v: unknown): string | undefined => (isObj(v) && typeof v.$ref === "string" && v.$ref.startsWith("#/components/schemas/") ? v.$ref.slice("#/components/schemas/".length) : undefined);

/**
 * An OpenAPI 3.0 or 3.1 document as evidence. Each object schema under
 * `components.schemas` is an entity; each operation is evidence, and a GET
 * returning one entity by a path parameter, or a list of them, says how the
 * entity is read. Evidence ids are `openapi:<source>#<JSON Pointer>`.
 */
export function fromOpenApi(doc: unknown, options: { readonly source: string; readonly system?: string }): CollectedSource {
  if (!isObj(doc) || typeof doc.openapi !== "string" || !/^3\.[01]\./.test(doc.openapi)) throw new Error(`Source ${options.source} is not an OpenAPI 3.0 or 3.1 document`);
  const source = options.source;
  const evidence: Evidence[] = [];
  const add = (id: string, text: string) => evidence.push({ id, source, text });
  const info = isObj(doc.info) ? doc.info : {};
  const title = typeof info.title === "string" ? info.title : source;
  add(`openapi:${source}#/info`, `API "${title}" ${typeof info.version === "string" ? info.version : ""}${typeof info.description === "string" ? `: "${info.description}"` : ""}`);
  const schemas = isObj(doc.components) && isObj(doc.components.schemas) ? doc.components.schemas : {};
  const entities: SourceEntity[] = [];
  for (const [name, raw] of Object.entries(schemas)) {
    const s = deref(doc, raw);
    if (!isObj(s) || !isObj(s.properties)) {
      if (isObj(s) && Array.isArray(s.enum)) add(`openapi:${source}#/components/schemas/${esc(name)}`, `Schema ${name}: one of ${s.enum.map((v) => JSON.stringify(v)).join(", ")}${typeof s.description === "string" ? `; "${s.description}"` : ""}`);
      continue;
    }
    const id = `openapi:${source}#/components/schemas/${esc(name)}`;
    const required = Array.isArray(s.required) ? (s.required as string[]) : [];
    add(id, `Schema ${name}${typeof s.description === "string" ? `: "${s.description}"` : ""}; required ${required.length ? required.join(", ") : "nothing"}`);
    const fields: SourceField[] = Object.entries(s.properties).map(([pname, praw]) => {
      const fid = `${id}/properties/${esc(pname)}`;
      const ps = inline(doc, praw);
      const resolved = deref(doc, praw);
      const description = typeof ps.description === "string" ? ps.description : isObj(resolved) && typeof resolved.description === "string" ? resolved.description : undefined;
      const type = Array.isArray(ps.type) ? ps.type : [ps.type];
      add(fid, `${name}.${pname}: ${describeSchema(ps)}${required.includes(pname) ? ", required" : ""}${refName(praw) ? ` (schema ${refName(praw)})` : ""}${description ? `; "${description}"` : ""}`);
      const { description: _d, ...schema } = ps;
      return {
        id: fid,
        name: pname,
        pointer: `/${esc(pname)}`,
        schema,
        nullable: type.includes("null"),
        required: required.includes(pname),
        ...(description ? { description } : {}),
        hints: sensitivityHints(pname, description)
      };
    });
    entities.push({ id, source, name, ...(typeof s.description === "string" ? { description: s.description } : {}), fields });
  }

  const globalScopes = scopesOf(doc.security);
  const operations: SourceOperation[] = [];
  const keys = new Map<string, string>();
  for (const [path, item] of Object.entries(isObj(doc.paths) ? doc.paths : {})) {
    if (!isObj(item)) continue;
    for (const method of ["get", "post", "put", "patch", "delete"] as const) {
      const op = item[method];
      if (!isObj(op)) continue;
      const id = `openapi:${source}#/paths/${esc(path)}/${method}`;
      const params = [...(Array.isArray(item.parameters) ? (item.parameters as unknown[]) : []), ...(Array.isArray(op.parameters) ? (op.parameters as unknown[]) : [])].map((p) => deref(doc, p)).filter(isObj);
      const pathParams = params.filter((p) => p.in === "path").map((p) => String(p.name));
      const query = params.filter((p) => p.in === "query").map((p) => String(p.name));
      const ok = isObj(op.responses) ? (op.responses["200"] ?? op.responses["201"]) : undefined;
      const okSchema = (() => {
        const r = deref(doc, ok);
        const c = isObj(r) && isObj(r.content) ? r.content["application/json"] : undefined;
        return isObj(c) ? c.schema : undefined;
      })();
      const bodySchema = (() => {
        const rb = deref(doc, op.requestBody);
        const c = isObj(rb) && isObj(rb.content) ? rb.content["application/json"] : undefined;
        return isObj(c) ? inline(doc, c.schema) : undefined;
      })();
      const scopes = op.security !== undefined ? scopesOf(op.security) : globalScopes;
      let role: OperationRole = method === "get" ? "get" : "command";
      let entity: string | undefined;
      let items: string | undefined;
      if (method === "get") {
        const direct = refName(okSchema);
        const resolved = deref(doc, okSchema);
        if (direct && pathParams.length > 0 && path.endsWith(`{${pathParams.at(-1)}}`)) {
          entity = `openapi:${source}#/components/schemas/${esc(direct)}`;
          keys.set(entity, pathParams.at(-1)!);
        } else if (isObj(resolved) && resolved.type === "array" && refName(resolved.items)) {
          role = "list";
          entity = `openapi:${source}#/components/schemas/${esc(refName(resolved.items)!)}`;
          items = "";
        } else if (isObj(resolved) && isObj(resolved.properties)) {
          const arr = Object.entries(resolved.properties).find(([, v]) => {
            const d = deref(doc, v);
            return isObj(d) && d.type === "array" && refName(d.items);
          });
          if (arr) {
            role = "list";
            entity = `openapi:${source}#/components/schemas/${esc(refName((deref(doc, arr[1]) as Json).items)!)}`;
            items = `/${esc(arr[0])}`;
          }
        }
      } else if (pathParams.length > 0) {
        // A command on one record: the entity whose get path this path extends.
        const base = path.slice(0, path.indexOf(`{${pathParams[0]}}`) + pathParams[0]!.length + 2);
        const getOp = isObj(doc.paths) && isObj(doc.paths[base]) ? doc.paths[base].get : undefined;
        const ok2 = isObj(getOp) && isObj(getOp.responses) ? deref(doc, getOp.responses["200"]) : undefined;
        const c2 = isObj(ok2) && isObj(ok2.content) ? ok2.content["application/json"] : undefined;
        const n = isObj(c2) ? refName(c2.schema) : undefined;
        if (n) entity = `openapi:${source}#/components/schemas/${esc(n)}`;
      }
      const ent = entity ? entities.find((e) => e.id === entity) : undefined;
      const queryParams = query.map((q) => {
        const f = ent?.fields.find((x) => x.name === q);
        return f ? { name: q, field: f.name } : { name: q };
      });
      add(
        id,
        `${method.toUpperCase()} ${path}${typeof op.operationId === "string" ? ` (${op.operationId})` : ""}${typeof op.summary === "string" ? `: "${op.summary}"` : ""}; ${role}${ent ? ` ${ent.name}` : ""}${pathParams.length ? `; path ${pathParams.join(", ")}` : ""}${query.length ? `; query ${query.join(", ")}` : ""}${bodySchema ? `; body ${describeSchema(bodySchema)}` : ""}${scopes.length ? `; scopes ${scopes.join(" ")}` : ""}`
      );
      operations.push({
        id,
        source,
        method: method.toUpperCase() as SourceOperation["method"],
        path,
        ...(typeof op.operationId === "string" ? { operationId: op.operationId } : {}),
        ...(typeof op.summary === "string" ? { summary: op.summary } : {}),
        role,
        ...(entity ? { entity } : {}),
        pathParams,
        queryParams,
        ...(items !== undefined ? { items } : {}),
        ...(bodySchema ? { body: bodySchema } : {}),
        scopes
      });
    }
  }
  // An entity's key is the field its get path names: `/members/{id}` and a field `id`.
  const keyed = entities.map((e) => {
    const k = keys.get(e.id);
    return k && e.fields.some((f) => f.name === k) ? { ...e, key: k } : e;
  });
  return {
    info: { id: source, kind: "openapi", system: title, ...(typeof info.description === "string" ? { description: info.description } : {}), digest: digestOf(doc) },
    entities: keyed,
    operations,
    ...authOf(doc),
    evidence
  };
}

function scopesOf(security: unknown): string[] {
  if (!Array.isArray(security)) return [];
  return [...new Set(security.flatMap((s) => (isObj(s) ? Object.values(s).flatMap((v) => (Array.isArray(v) ? v.map(String) : [])) : [])))];
}

function authOf(doc: Json): { auth?: SourceAuth } {
  const schemes = isObj(doc.components) && isObj(doc.components.securitySchemes) ? doc.components.securitySchemes : {};
  for (const s of Object.values(schemes)) {
    if (!isObj(s)) continue;
    if (s.type === "oauth2" && isObj(s.flows) && isObj(s.flows.clientCredentials)) {
      const cc = s.flows.clientCredentials;
      return { auth: { kind: "client-credentials", ...(typeof cc.tokenUrl === "string" ? { tokenUrl: cc.tokenUrl } : {}), scopes: isObj(cc.scopes) ? Object.keys(cc.scopes) : [] } };
    }
    if (s.type === "apiKey" && s.in === "header" && typeof s.name === "string") return { auth: { kind: "api-key", header: s.name } };
  }
  return Object.keys(schemes).length ? {} : { auth: { kind: "none" } };
}

function describeSchema(s: JsonSchema2020): string {
  const t = Array.isArray(s.type) ? s.type.join("|") : (s.type ?? "any");
  const extra = [
    s.format ? `format ${s.format}` : "",
    s.enum ? `one of ${s.enum.map((v) => JSON.stringify(v)).join(", ")}` : "",
    s.type === "array" && s.items && !Array.isArray(s.items) ? `of ${describeSchema(s.items)}` : "",
    s.type === "object" && s.properties ? `{${Object.keys(s.properties).join(", ")}}` : ""
  ].filter(Boolean);
  return [t, ...extra].join(" ");
}

// --------------------------------------------------------------- json schema

/**
 * JSON Schema documents as evidence: each object schema is an entity.
 * `key` names the field holding identity when the schemas do not; evidence
 * ids are `schema:<source>/<title>[/<property>]`.
 */
export function fromJsonSchema(docs: readonly unknown[], options: { readonly source: string; readonly system?: string; readonly keys?: Readonly<Record<string, string>> }): CollectedSource {
  const source = options.source;
  const evidence: Evidence[] = [];
  const entities: SourceEntity[] = [];
  for (const d of docs) {
    if (!isObj(d) || !isObj(d.properties)) continue;
    const name = typeof d.title === "string" ? d.title : typeof d.$id === "string" ? d.$id.split("/").filter(Boolean).at(-1)! : undefined;
    if (!name) throw new Error(`A schema in ${source} has neither a title nor an $id`);
    const id = `schema:${source}/${name}`;
    const required = Array.isArray(d.required) ? (d.required as string[]) : [];
    evidence.push({ id, source, text: `Schema ${name}${typeof d.$id === "string" ? ` (${d.$id})` : ""}${typeof d.description === "string" ? `: "${d.description}"` : ""}; required ${required.join(", ") || "nothing"}` });
    const fields: SourceField[] = Object.entries(d.properties).map(([p, raw]) => {
      const ps = inline(d, raw);
      const fid = `${id}/${p}`;
      const description = typeof ps.description === "string" ? ps.description : undefined;
      evidence.push({ id: fid, source, text: `${name}.${p}: ${describeSchema(ps)}${required.includes(p) ? ", required" : ""}${description ? `; "${description}"` : ""}` });
      const { description: _d, ...schema } = ps;
      const type = Array.isArray(ps.type) ? ps.type : [ps.type];
      return { id: fid, name: p, pointer: `/${esc(p)}`, schema, nullable: type.includes("null"), required: required.includes(p), ...(description ? { description } : {}), hints: sensitivityHints(p, description) };
    });
    const key = options.keys?.[name] ?? (fields.some((f) => f.name === "id") ? "id" : undefined);
    entities.push({ id, source, name, ...(typeof d.description === "string" ? { description: d.description } : {}), ...(key ? { key } : {}), fields });
  }
  return { info: { id: source, kind: "json-schema", system: options.system ?? source, digest: digestOf(docs) }, entities, operations: [], evidence };
}
