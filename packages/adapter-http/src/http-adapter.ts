import {
  AdapterUnavailableError,
  SourceRefusedError,
  UnsupportedResolutionError,
  applySort,
  matchesFilter,
  parseResolution,
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
 * Where a canonical field comes from in the service's JSON: a JSON Pointer
 * (RFC 6901, `/quantity/on_hand`), or a pointer and a table translating
 * the service's codes into the model's values.
 */
export type HttpField = string | { readonly from: string; readonly map: Readonly<Record<string, unknown>> };

/** How one Type maps onto the service. */
export interface HttpTypeMapping {
  /** Path of one record, with `{id}` for the object id (URI-encoded). */
  readonly get: string;
  readonly list: {
    readonly path: string;
    /** Pointer to the array of records in a list response (`""` for a bare array). */
    readonly items: string;
    /** Pointer to the next page's cursor, when the service pages. */
    readonly next?: string;
    readonly cursorParam?: string;
    readonly pageSizeParam?: string;
    readonly pageSize?: number;
    /** Canonical fields the service can filter on (`eq` only), and the query parameter for each. */
    readonly params?: Readonly<Record<string, string>>;
  };
  /** Pointer to the record's id: the object id. */
  readonly id: string;
  /** Canonical property name → where it is in the record. */
  readonly fields: Readonly<Record<string, HttpField>>;
}

export type HttpAuth =
  /** A fixed credential in one header: an API key, a depot key. */
  | { readonly kind: "header"; readonly name: string; readonly value: string }
  /** OAuth 2.0 client credentials (RFC 6749 §4.4); the token is cached until it expires, and refreshed once on a 401. */
  | { readonly kind: "client-credentials"; readonly tokenUrl: string; readonly clientId: string; readonly clientSecret: string; readonly scope?: string };

export interface HttpAdapterConfig {
  readonly dataSourceId: string;
  /** The system's name, as provenance reports it. */
  readonly system: string;
  readonly baseUrl: string;
  readonly auth?: HttpAuth;
  readonly types: Readonly<Record<string, HttpTypeMapping>>;
  /** Most pages one query reads before refusing to answer from a partial list. Default 20. */
  readonly maxPages?: number;
  readonly fetch?: typeof fetch;
}

/** RFC 6901: `""` is the whole document; `~1` is `/` and `~0` is `~`. */
export function pointer(doc: unknown, ptr: string): unknown {
  if (ptr === "") return doc;
  if (!ptr.startsWith("/")) throw new TypeError(`"${ptr}" is not a JSON Pointer`);
  let at: unknown = doc;
  for (const raw of ptr.slice(1).split("/")) {
    const key = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (at === null || typeof at !== "object" || !Object.hasOwn(at, key)) return undefined;
    at = (at as Record<string, unknown>)[key];
  }
  return at;
}

const fieldOf = (f: HttpField) => (typeof f === "string" ? f : f.from);

/**
 * An Adapter over an independent HTTP/JSON service (ADR-0072), driven by a
 * mapping rather than code: which path serves a record and a list, where
 * each canonical field is in the service's JSON, and which credential the
 * service wants. The runtime sees canonical values only; a change in the
 * service's schema is a change in the mapping.
 *
 * Errors keep their meaning across the boundary: a refusal by the service
 * (401, 403) is a `SourceRefusedError`; a failure to answer (a 5xx, a
 * network error) is an `AdapterUnavailableError`; a record the service
 * does not have is an empty result. Each is something the runtime can
 * report on the object rather than guess at.
 */
export class HttpAdapter implements Adapter {
  readonly dataSourceId: string;
  private readonly fetch: typeof fetch;
  private token: { value: string; expiresAt: number } | undefined;

  constructor(private readonly config: HttpAdapterConfig) {
    this.dataSourceId = config.dataSourceId;
    this.fetch = config.fetch ?? globalThis.fetch.bind(globalThis);
    for (const [type, m] of Object.entries(config.types)) {
      for (const p of [m.id, m.list.items, m.list.next, ...Object.values(m.fields).map(fieldOf)]) {
        if (p !== undefined && p !== "" && !p.startsWith("/")) throw new TypeError(`${type}: "${p}" is not a JSON Pointer`);
      }
    }
  }

  private mapping(typeName: string): HttpTypeMapping {
    const m = this.config.types[typeName];
    if (!m) throw new Error(`HttpAdapter "${this.dataSourceId}" has no mapping for type "${typeName}"`);
    return m;
  }

  private async authHeaders(signal: AbortSignal | undefined, renew = false): Promise<Record<string, string>> {
    const auth = this.config.auth;
    if (!auth) return {};
    if (auth.kind === "header") return { [auth.name]: auth.value };
    if (renew || !this.token || this.token.expiresAt <= Date.now()) {
      const form = new URLSearchParams({ grant_type: "client_credentials", client_id: auth.clientId, client_secret: auth.clientSecret, ...(auth.scope ? { scope: auth.scope } : {}) });
      const res = await this.send(auth.tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form.toString(), ...(signal ? { signal } : {}) });
      if (res.status === 400 || res.status === 401) throw new SourceRefusedError(`${this.config.system} refused the client credentials (${res.status})`, this.dataSourceId);
      if (!res.ok) throw new AdapterUnavailableError(`${this.config.system} token endpoint answered ${res.status}`);
      const body = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
      if (typeof body.access_token !== "string") throw new AdapterUnavailableError(`${this.config.system} issued no access token`);
      const ttl = typeof body.expires_in === "number" ? body.expires_in * 1000 : 60_000;
      // Renew a little early, so a token never expires between this check and the service's.
      this.token = { value: body.access_token, expiresAt: Date.now() + Math.max(0, ttl - 5_000) };
    }
    return { authorization: `Bearer ${this.token.value}` };
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetch(url, init);
    } catch (err) {
      if (init.signal?.aborted) throw err;
      throw new AdapterUnavailableError(`${this.config.system} could not be reached: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** GET a path; `undefined` for a 404. */
  private async get(path: string, signal?: AbortSignal): Promise<unknown> {
    const url = new URL(path, this.config.baseUrl).href;
    const init = (headers: Record<string, string>): RequestInit => ({ headers: { accept: "application/json", ...headers }, ...(signal ? { signal } : {}) });
    let res = await this.send(url, init(await this.authHeaders(signal)));
    if (res.status === 401 && this.config.auth?.kind === "client-credentials") res = await this.send(url, init(await this.authHeaders(signal, true)));
    if (res.status === 404) return undefined;
    if (res.status === 401 || res.status === 403) throw new SourceRefusedError(`${this.config.system} refused the request (${res.status})`, this.dataSourceId);
    if (!res.ok) throw new AdapterUnavailableError(`${this.config.system} answered ${res.status}`);
    try {
      return await res.json();
    } catch {
      throw new AdapterUnavailableError(`${this.config.system} answered with something that is not JSON`);
    }
  }

  private canonical(m: HttpTypeMapping, record: unknown): { objectId: string; values: Record<string, unknown>; provenance: ProvenanceRef[] } | undefined {
    const id = pointer(record, m.id);
    if (typeof id !== "string" && typeof id !== "number") return undefined;
    const objectId = String(id);
    const retrievedAt = new Date().toISOString();
    const values: Record<string, unknown> = {};
    const provenance: ProvenanceRef[] = [];
    for (const [name, f] of Object.entries(m.fields)) {
      const raw = pointer(record, fieldOf(f));
      if (raw === undefined) continue;
      const value = typeof f === "string" ? raw : typeof raw === "string" && Object.hasOwn(f.map, raw) ? f.map[raw] : undefined;
      if (value === undefined) continue;
      values[name] = value;
      provenance.push({ propertyPath: name, source: { dataSourceId: this.dataSourceId, system: this.config.system, recordId: objectId, field: fieldOf(f).slice(1).replaceAll("/", ".") }, retrievedAt });
    }
    return { objectId, values, provenance };
  }

  async resolveProperties(typeName: string, objectId: string, _propertyNames: string[], opts?: AdapterCallOptions): Promise<ResolvedProperties> {
    const m = this.mapping(typeName);
    const record = await this.get(m.get.replace("{id}", encodeURIComponent(objectId)), opts?.signal);
    const c = record === undefined ? undefined : this.canonical(m, record);
    return c && c.objectId === objectId ? { values: c.values, provenance: c.provenance } : { values: {}, provenance: [] };
  }

  /** Every record the service returns for the conditions it can filter on, every page, canonical. */
  private async list(typeName: string, filter: QueryFilter | undefined, signal?: AbortSignal) {
    const m = this.mapping(typeName);
    const params = new URLSearchParams();
    for (const c of pushable(filter)) {
      // Only a field the service holds as-is: a translated code would be compared with the wrong value.
      const param = typeof m.fields[c.property] === "string" ? m.list.params?.[c.property] : undefined;
      if (param && (typeof c.value === "string" || typeof c.value === "number")) params.set(param, String(c.value));
    }
    if (m.list.pageSizeParam && m.list.pageSize) params.set(m.list.pageSizeParam, String(m.list.pageSize));
    const out: NonNullable<ReturnType<HttpAdapter["canonical"]>>[] = [];
    let cursor: string | undefined;
    for (let page = 0; ; page++) {
      if (page >= (this.config.maxPages ?? 20)) throw new AdapterUnavailableError(`${this.config.system} has more than ${this.config.maxPages ?? 20} pages for ${typeName}; narrow the query`);
      const p = new URLSearchParams(params);
      if (cursor !== undefined && m.list.cursorParam) p.set(m.list.cursorParam, cursor);
      const qs = p.toString();
      const body = await this.get(`${m.list.path}${qs ? `?${qs}` : ""}`, signal);
      const items = pointer(body, m.list.items);
      if (!Array.isArray(items)) throw new AdapterUnavailableError(`${this.config.system}'s list for ${typeName} has no array at "${m.list.items}"`);
      for (const r of items) {
        const c = this.canonical(m, r);
        if (c) out.push(c);
      }
      const next = m.list.next === undefined ? undefined : pointer(body, m.list.next);
      if (typeof next !== "string" || next === "" || !m.list.cursorParam) break;
      cursor = next;
    }
    return out;
  }

  async queryByType(typeName: string, filter?: QueryFilter, limit?: number, cursor?: string, sort?: SortKey[], opts?: AdapterCallOptions): Promise<AdapterQueryResult> {
    // The service filters what it can; every condition is then decided here exactly as matchesFilter decides it.
    const all = (await this.list(typeName, filter, opts?.signal)).filter((o) => matchesFilter(o.values, filter));
    const sorted = applySort(all, sort, (o) => o.values);
    const start = cursor === undefined ? 0 : Number(cursor);
    if (!Number.isInteger(start) || start < 0) throw new TypeError(`Invalid cursor "${cursor}"`);
    const end = limit === undefined ? sorted.length : start + limit;
    return { items: sorted.slice(start, end), ...(end < sorted.length ? { nextCursor: String(end) } : {}) };
  }

  /** Every condition is evaluated in `queryByType` with `matchesFilter` itself (ADR-0040). */
  canFilter(typeName: string, property: string, _operator: QueryOperator): boolean {
    return Object.hasOwn(this.mapping(typeName).fields, property);
  }

  async resolveRelationship(relationship: RelationshipDefinition, sourceObjectId: string, opts?: AdapterCallOptions): Promise<RelatedRef[]> {
    const strategy = parseResolution(relationship.resolution.operation);
    if (strategy.kind !== "byForeignKey") throw new UnsupportedResolutionError(`HttpAdapter supports byForeignKey relationships, not "${strategy.kind}"`);
    const filter: QueryFilter = { property: strategy.field, operator: "eq", value: sourceObjectId };
    const related = (await this.list(relationship.targetType, filter, opts?.signal)).filter((o) => matchesFilter(o.values, filter));
    return related.map((o) => ({ objectId: o.objectId }));
  }

  executeAction(action: ActionDefinition): Promise<unknown> {
    return Promise.reject(new Error(`HttpAdapter "${this.dataSourceId}" implements no Actions (asked for ${action.name})`));
  }
}

/** The `eq` conditions a filter requires of every match: the top level, or every member of an `and`. */
function pushable(filter: QueryFilter | undefined): { property: string; value: unknown }[] {
  if (!filter) return [];
  if ("and" in filter) return filter.and.flatMap(pushable);
  if ("or" in filter) return [];
  return filter.operator === "eq" ? [{ property: filter.property, value: filter.value }] : [];
}
