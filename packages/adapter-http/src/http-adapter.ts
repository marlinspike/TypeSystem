import {
  AdapterUnavailableError,
  SourceRefusedError,
  UnsupportedResolutionError,
  applySort,
  computeAggregations,
  matchesFilter,
  parseResolution,
  type ActionDefinition,
  type ActionContext,
  type Adapter,
  type AdapterCallOptions,
  type AdapterQueryResult,
  type AggregateResult,
  type ProvenanceRef,
  type QueryFilter,
  type QueryOperator,
  type RelatedRef,
  type RelationshipDefinition,
  type ResolvedProperties,
  type SemanticAggregateQuery,
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

/**
 * How one Action is carried out by the service (ADR-0076): a request whose
 * path takes `{field}` values from the Action's input, URI-encoded, and
 * whose JSON body is the rest of the input (or the fields `body` names).
 */
export interface HttpActionMapping {
  readonly method: "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
  readonly body?: readonly string[];
}

export interface HttpAdapterConfig {
  readonly dataSourceId: string;
  /** The system's name, as provenance reports it. */
  readonly system: string;
  readonly baseUrl: string;
  readonly auth?: HttpAuth;
  readonly types: Readonly<Record<string, HttpTypeMapping>>;
  /** Action name → the request that carries it out. An Action not listed is refused. */
  readonly actions?: Readonly<Record<string, HttpActionMapping>>;
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
 * The service's field, as provenance names it: the decoded key for a
 * top-level field (`/mc~1status` is `mc/status`), dotted keys for a nested
 * one (`/nested/unit` is `nested.unit`), and the pointer itself when a key
 * holds a dot or a slash, so no two pointers are named alike.
 */
export function fieldName(ptr: string): string {
  const keys = ptr.slice(1).split("/").map((k) => k.replaceAll("~1", "/").replaceAll("~0", "~"));
  if (keys.some((k) => k.includes("."))) return ptr;
  if (keys.length === 1) return keys[0]!;
  return keys.some((k) => k.includes("/")) ? ptr : keys.join(".");
}

/** A URL with any user name and password removed, for messages. */
function withoutCredentials(text: string, baseUrl: string): string {
  let out = text;
  try {
    const u = new URL(baseUrl);
    for (const secret of [u.password, u.username, decodeURIComponent(u.password), decodeURIComponent(u.username)]) {
      if (secret) out = out.replaceAll(secret, "***");
    }
  } catch {
    // Not a URL: nothing in it to hide.
  }
  return out.replace(/\/\/[^/@\s]*@/g, "//***@");
}

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
  /** The token request in flight, shared by every read that needs a token meanwhile. */
  private tokenRequest: Promise<string> | undefined;

  constructor(private readonly config: HttpAdapterConfig) {
    this.dataSourceId = config.dataSourceId;
    this.fetch = config.fetch ?? globalThis.fetch.bind(globalThis);
    for (const [type, m] of Object.entries(config.types)) {
      for (const p of [m.id, m.list.items, m.list.next, ...Object.values(m.fields).map(fieldOf)]) {
        if (p !== undefined && p !== "" && !p.startsWith("/")) throw new TypeError(`${type}: "${p}" is not a JSON Pointer`);
      }
      // A cursor the adapter cannot send back would end every list after its first page.
      if (m.list.next !== undefined && !m.list.cursorParam) throw new TypeError(`${type}: list names a next cursor but no cursorParam to send it in`);
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
      // One token request at a time: concurrent reads wait for the same token instead of each fetching one.
      this.tokenRequest ??= this.requestToken(auth, signal).finally(() => (this.tokenRequest = undefined));
      return { authorization: `Bearer ${await this.tokenRequest}` };
    }
    return { authorization: `Bearer ${this.token.value}` };
  }

  private async requestToken(auth: Extract<HttpAuth, { kind: "client-credentials" }>, signal: AbortSignal | undefined): Promise<string> {
    const form = new URLSearchParams({ grant_type: "client_credentials", client_id: auth.clientId, client_secret: auth.clientSecret, ...(auth.scope ? { scope: auth.scope } : {}) });
    const res = await this.send(auth.tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form.toString(), ...(signal ? { signal } : {}) });
    if (res.status === 400 || res.status === 401 || res.status === 403) throw new SourceRefusedError(`${this.config.system} refused the client credentials (${res.status})`, this.dataSourceId);
    if (!res.ok) throw new AdapterUnavailableError(`${this.config.system} token endpoint answered ${res.status}`);
    let body: { access_token?: unknown; expires_in?: unknown };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      throw new AdapterUnavailableError(`${this.config.system} token endpoint answered with something that is not JSON`);
    }
    if (typeof body?.access_token !== "string") throw new AdapterUnavailableError(`${this.config.system} issued no access token`);
    const ttl = typeof body.expires_in === "number" ? body.expires_in * 1000 : 60_000;
    // Renew a little early, so a token never expires between this check and the service's.
    this.token = { value: body.access_token, expiresAt: Date.now() + Math.max(0, ttl - 5_000) };
    return body.access_token;
  }

  /**
   * One request, never redirected: a redirect would carry TypeSystem's
   * credential (a key header, or a re-posted client secret) to wherever the
   * service points, so it is reported as the service failing to answer.
   */
  private async send(url: string, init: RequestInit): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetch(url, { ...init, redirect: "manual" });
    } catch (err) {
      if (init.signal?.aborted) throw err;
      throw new AdapterUnavailableError(withoutCredentials(`${this.config.system} could not be reached: ${err instanceof Error ? err.message : String(err)}`, this.config.baseUrl));
    }
    if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
      throw new AdapterUnavailableError(`${this.config.system} answered with a redirect (${res.status}), which TypeSystem does not follow with its credentials`);
    }
    return res;
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
      provenance.push({ propertyPath: name, source: { dataSourceId: this.dataSourceId, system: this.config.system, recordId: objectId, field: fieldName(fieldOf(f)) }, retrievedAt });
    }
    return { objectId, values, provenance };
  }

  async resolveProperties(typeName: string, objectId: string, _propertyNames: string[], opts?: AdapterCallOptions): Promise<ResolvedProperties> {
    const m = this.mapping(typeName);
    // `.` and `..` (however encoded) would be resolved by the URL parser into another endpoint.
    if (objectId === "." || objectId === "..") return { values: {}, provenance: [] };
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
      // The caller's to fix, not an outage: reading the same pages again would answer the same.
      if (page >= (this.config.maxPages ?? 20)) throw new AdapterUnavailableError(`${this.config.system} has more than ${this.config.maxPages ?? 20} pages for ${typeName}; narrow the query`, { retryable: false });
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
      if (next === undefined || next === null || next === "") break;
      if (typeof next !== "string" && typeof next !== "number") throw new AdapterUnavailableError(`${this.config.system}'s list for ${typeName} has a next cursor that is neither a string nor a number`);
      cursor = String(next);
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

  /**
   * Grouped counts and sums, computed here over every record the service
   * lists (every page, up to `maxPages`, or refused), since a service rarely
   * has an aggregate endpoint of its own. The runtime has already narrowed
   * the filter to the rows the caller may read.
   */
  async aggregate(query: SemanticAggregateQuery, opts?: AdapterCallOptions): Promise<AggregateResult> {
    const rows = (await this.list(query.type, query.filter, opts?.signal)).filter((o) => matchesFilter(o.values, query.filter)).map((o) => o.values);
    return computeAggregations(rows, query);
  }

  /** Every condition is evaluated in `queryByType` with `matchesFilter` itself (ADR-0040). */
  canFilter(typeName: string, property: string, _operator: QueryOperator): boolean {
    return Object.hasOwn(this.mapping(typeName).fields, property);
  }

  async resolveRelationship(relationship: RelationshipDefinition, sourceObjectId: string, opts?: AdapterCallOptions): Promise<RelatedRef[]> {
    const strategy = parseResolution(relationship.resolution.operation);
    if (strategy.kind === "byOwnField") {
      // The source object names its targets in one of its own values: a facility code on a shipment.
      // The targets may live in another system: the runtime reads each from its own source (ADR-0094).
      const own = (await this.resolveProperties(relationship.sourceType, sourceObjectId, [strategy.field], opts)).values[strategy.field];
      const ids = Array.isArray(own) ? own : own === undefined || own === null || own === "" ? [] : [own];
      return ids.filter((id): id is string | number => typeof id === "string" || typeof id === "number").map((id) => ({ objectId: String(id) }));
    }
    if (strategy.kind !== "byForeignKey") throw new UnsupportedResolutionError(`HttpAdapter supports byForeignKey and byOwnField relationships, not "${strategy.kind}"`);
    const filter: QueryFilter = { property: strategy.field, operator: "eq", value: sourceObjectId };
    const related = (await this.list(relationship.targetType, filter, opts?.signal)).filter((o) => matchesFilter(o.values, filter));
    return related.map((o) => ({ objectId: o.objectId }));
  }

  async executeAction(action: ActionDefinition, input: unknown, _ctx: ActionContext, opts?: AdapterCallOptions): Promise<unknown> {
    const m = this.config.actions?.[action.name];
    if (!m) throw new Error(`HttpAdapter "${this.dataSourceId}" has no request for Action ${action.name}`);
    const fields = input !== null && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
    const used = new Set<string>();
    const path = m.path.replace(/\{([A-Za-z0-9_]+)\}/g, (_, name: string) => {
      const v = fields[name];
      if (typeof v !== "string" && typeof v !== "number") throw new TypeError(`Action ${action.name} needs "${name}" for its path`);
      used.add(name);
      // `.` and `..` would be resolved by the URL parser into another endpoint.
      if (v === "." || v === "..") throw new TypeError(`Action ${action.name}: "${name}" is not a valid path segment`);
      return encodeURIComponent(String(v));
    });
    const body = Object.fromEntries(Object.entries(fields).filter(([k]) => (m.body ? m.body.includes(k) : !used.has(k))));
    const url = new URL(path, this.config.baseUrl).href;
    const signal = opts?.signal;
    const init = (headers: Record<string, string>): RequestInit => ({
      method: m.method,
      headers: { accept: "application/json", "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {})
    });
    let res = await this.send(url, init(await this.authHeaders(signal)));
    if (res.status === 401 && this.config.auth?.kind === "client-credentials") res = await this.send(url, init(await this.authHeaders(signal, true)));
    if (res.status === 401 || res.status === 403) throw new SourceRefusedError(`${this.config.system} refused ${action.name} (${res.status})`, this.dataSourceId);
    // Not retried: the service answered, and the request may already have had its effect.
    if (res.status >= 500) throw new AdapterUnavailableError(`${this.config.system} answered ${res.status} to ${action.name}`, { retryable: false });
    if (!res.ok) throw new Error(`${this.config.system} rejected ${action.name} (${res.status})`);
    const text = await res.text();
    if (!text) return {};
    let answer: unknown;
    try {
      answer = JSON.parse(text) as unknown;
    } catch {
      throw new AdapterUnavailableError(`${this.config.system} answered ${action.name} with something that is not JSON`, { retryable: false });
    }
    // An answer describing an object of the Action's output Type is that object, mapped as a read maps it, so
    // the runtime can release it like a read (ADR-0075); the service's own field names never reach a caller.
    const out = action.outputType ? this.config.types[action.outputType] : undefined;
    if (!out) return answer;
    const c = this.canonical(out, answer);
    return c ? { id: c.objectId, ...c.values } : {};
  }
}

/** The `eq` conditions a filter requires of every match: the top level, or every member of an `and`. */
function pushable(filter: QueryFilter | undefined): { property: string; value: unknown }[] {
  if (!filter) return [];
  if ("and" in filter) return filter.and.flatMap(pushable);
  if ("or" in filter) return [];
  return filter.operator === "eq" ? [{ property: filter.property, value: filter.value }] : [];
}
