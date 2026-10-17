import type { ActionDefinition, DataSource, DomainManifest, DomainTypeEntry, JsonSchema2020, Mapping, SemanticTypeSchema, XProvenance, XRelationships } from "@typesys/core";
import { HttpAdapter, type HttpActionMapping, type HttpTypeMapping } from "@typesys/adapter-http";
import { PostgresTableAdapter, type PostgresColumn, type PostgresTableMapping } from "@typesys/adapter-postgres";
import type { Pool } from "pg";
import { kebab, type Proposal, type ProposedType } from "./proposal.js";
import { MARKINGS, type SourceModel } from "./sources.js";

/**
 * How a deployment reaches each source: generated with the model, holding
 * no credential. Each names the environment variables that hold its
 * connection string or client credentials, read when the adapters are made.
 */
export type AdapterPlan =
  | {
      readonly kind: "postgres-table";
      readonly dataSourceId: string;
      readonly system: string;
      /** The variable holding the connection string. */
      readonly connectionEnv: string;
      readonly types: Readonly<Record<string, PostgresTableMapping>>;
    }
  | {
      readonly kind: "http";
      readonly dataSourceId: string;
      readonly system: string;
      /** The variable holding the service's base URL. */
      readonly baseUrlEnv: string;
      readonly auth?:
        | { readonly kind: "client-credentials"; readonly tokenPath: string; readonly clientIdEnv: string; readonly clientSecretEnv: string; readonly scope: string }
        | { readonly kind: "header"; readonly name: string; readonly valueEnv: string }
        | { readonly kind: "basic"; readonly usernameEnv: string; readonly passwordEnv: string };
      readonly types: Readonly<Record<string, HttpTypeMapping>>;
      readonly actions: Readonly<Record<string, HttpActionMapping>>;
    };

export interface BuiltDomain {
  readonly manifest: DomainManifest;
  readonly adapters: readonly AdapterPlan[];
  /**
   * The policy rules the domain names and a deployment must supply: one to
   * read each Type, one per kind of sensitive data, one to invoke each
   * Action. Onboarding names them; it never writes them (ADR-0076). A rule
   * the deployment does not supply is refused at install.
   */
  readonly policies: readonly string[];
  /** What the sources cannot serve as proposed, said rather than silently dropped. */
  readonly notes: readonly string[];
}

const env = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, "_");

/** The `typesys.pack/1` contents of a proposal: Types, relationships, policies by name, Actions, data sources and mappings, and the adapter configuration that serves them. */
export function buildDomain(model: SourceModel, p: Proposal, version = "1.0.0"): BuiltDomain {
  const basePathOf = (source: string) => model.sources.find((x) => x.info.id === source)?.info.basePath ?? "";
  const notes: string[] = [];
  const policies = new Set<string>();
  const typeOf = new Map(p.types.map((t) => [t.entity, t]));
  const owner = (field: string) => {
    const f = model.field(field);
    const t = f ? typeOf.get(f.entity.id) : undefined;
    return f && t ? { ...f, type: t, prop: t.properties.find((x) => x.field === field)! } : undefined;
  };
  const sourceOf = (t: ProposedType) => model.entity(t.entity)!.source;
  const kindOf = (source: string) => model.sources.find((s) => s.info.id === source)!.info.kind;

  const rels = new Map<string, XRelationships>();
  const addRel = (t: ProposedType, name: string, spec: XRelationships[string]) => rels.set(t.name, { ...(rels.get(t.name) ?? {}), [name]: spec });
  for (const r of p.relationships) {
    const from = owner(r.from);
    const to = owner(r.to);
    if (!from || !to) continue;
    const src = sourceOf(from.type);
    // The referenced Type lists what references it from the referencing source; every adapter filters on a field.
    addRel(to.type, r.inverse, { target: from.type.name, cardinality: "one-to-many", ...(r.description ? { description: r.description } : {}), resolution: { dataSourceId: src, operation: `byForeignKey:${from.prop.name}` }, ...(src !== sourceOf(to.type) ? { optional: true } : {}) });
    if (kindOf(src) === "postgres") {
      addRel(from.type, r.name, { target: to.type.name, cardinality: "one-to-one", ...(r.description ? { description: r.description } : {}), resolution: { dataSourceId: src, operation: `byOwnField:${from.prop.name}` }, ...(src !== sourceOf(to.type) ? { optional: true } : {}) });
    } else {
      notes.push(`${from.type.name}.${r.name} is not served: ${src} is read over HTTP, which follows a reference only from the referenced side (${to.type.name}.${r.inverse})`);
    }
  }

  const actionsByType = new Map<string, string[]>();
  const actions: ActionDefinition[] = [];
  const httpActions = new Map<string, Record<string, HttpActionMapping>>();
  for (const a of p.actions) {
    const op = model.operation(a.operation)!;
    const t = typeOf.get(op.entity!);
    if (!t) continue;
    const keyProp = t.properties.find((x) => x.name === t.key)!;
    const body = op.body && op.body.type === "object" ? op.body : { type: "object", properties: {} };
    const bodyProps = { ...(body.properties ?? {}) };
    if (Object.hasOwn(bodyProps, keyProp.name)) {
      notes.push(`${a.name} is not offered: its body has a field named like ${t.name}'s key (${keyProp.name})`);
      continue;
    }
    const policy = `${p.domain}.invoke-${kebab(a.name)}`;
    policies.add(policy);
    const created = op.method === "POST" && op.pathParams.length === 0;
    actions.push({
      id: `action-${kebab(p.domain)}-${kebab(a.name)}`,
      name: a.name,
      version,
      description: a.description,
      applicableTypes: [t.name],
      target: { idFrom: keyProp.name, type: t.name },
      inputSchema: { type: "object", properties: { [keyProp.name]: { type: "string" }, ...bodyProps }, required: [keyProp.name, ...(body.required ?? [])], additionalProperties: false },
      outputSchema: { type: "object" },
      outputType: t.name,
      authorizationPolicy: policy,
      implementation: { dataSourceId: op.source, operation: `${op.method} ${op.path}` },
      sideEffects: created ? "creates" : "mutates",
      idempotency: op.method === "PUT" || op.method === "DELETE" ? "natural" : "none",
      auditRequired: true
    });
    actionsByType.set(t.name, [...(actionsByType.get(t.name) ?? []), a.name]);
    httpActions.set(op.source, { ...(httpActions.get(op.source) ?? {}), [a.name]: { method: op.method as HttpActionMapping["method"], path: basePathOf(op.source) + op.path.replace(`{${op.pathParams[0]}}`, `{${keyProp.name}}`), body: Object.keys(bodyProps) } });
  }

  const types: DomainTypeEntry[] = p.types.map((t) => {
    const local = t.name.split(".")[1]!;
    const objectPolicy = `${p.domain}.read-${kebab(local)}`;
    policies.add(objectPolicy);
    const propertyPolicies: Record<string, string> = {};
    const provenance: NonNullable<XProvenance["properties"]> = {};
    for (const s of p.sensitive) {
      const o = owner(s.field);
      if (o?.type !== t) continue;
      // The marking as a classification scheme names it: `TOP SECRET` is `TOP_SECRET`.
      if (s.marking) {
        // A field flagged twice keeps its most restrictive marking, whichever came last.
        const marking = s.marking.replace(/ /g, "_");
        const held = provenance[o.prop.name]?.classification;
        const rank = (m: string) => MARKINGS.findIndex((x) => x.replace(/ /g, "_") === m);
        if (held === undefined || rank(marking) < rank(held)) provenance[o.prop.name] = { classification: marking };
      }
      else if (!propertyPolicies[o.prop.name]) {
        // One rule per kind of data, not per field: an expert decides who may read personal names once.
        const rule = `${p.domain}.${s.category}`;
        propertyPolicies[o.prop.name] = rule;
        policies.add(rule);
      }
    }
    const schema: SemanticTypeSchema = {
      $id: `urn:typesys:type:${t.name}:${version}`,
      title: local,
      ...(t.description ? { description: t.description } : {}),
      type: "object",
      properties: Object.fromEntries(t.properties.map((x) => [x.name, { ...x.schema, ...(x.description ? { description: x.description } : {}) } satisfies JsonSchema2020])),
      required: t.properties.filter((x) => x.required).map((x) => x.name),
      ...(rels.has(t.name) ? { "x-relationships": rels.get(t.name)! } : {}),
      ...(actionsByType.has(t.name) ? { "x-actions": { actions: actionsByType.get(t.name)! } } : {}),
      "x-policy": { objectPolicy, ...(Object.keys(propertyPolicies).length ? { propertyPolicies } : {}) },
      ...(Object.keys(provenance).length ? { "x-provenance": { properties: provenance } } : {}),
      "x-metadata": { onboardedFrom: t.entity }
    };
    return { schema, options: { name: t.name, version } };
  });

  const dataSources: DataSource[] = model.sources
    .filter((s) => p.types.some((t) => sourceOf(t) === s.info.id))
    .map((s) => ({ id: s.info.id, name: s.info.system, kind: s.info.kind === "postgres" ? "postgres" : "http" }));
  const mappings: Mapping[] = p.types.map((t) => ({ id: `map-${kebab(t.name)}`, typeName: t.name, target: "property", targetName: "*", dataSourceId: sourceOf(t), operation: "get", resolutionMode: "live" }));

  const adapters: AdapterPlan[] = [];
  for (const s of model.sources) {
    const mine = p.types.filter((t) => sourceOf(t) === s.info.id);
    if (mine.length === 0) continue;
    if (s.info.kind === "postgres") {
      const tables: Record<string, PostgresTableMapping> = {};
      for (const t of mine) {
        const e = model.entity(t.entity)!;
        tables[t.name] = {
          table: e.name,
          id: e.key!,
          columns: Object.fromEntries(
            t.properties.map((x) => {
              const f = e.fields.find((y) => y.id === x.field)!;
              return [x.name, f.as ? ({ column: f.name, as: f.as } satisfies PostgresColumn) : f.name];
            })
          )
        };
      }
      adapters.push({ kind: "postgres-table", dataSourceId: s.info.id, system: s.info.system, connectionEnv: `${env(s.info.id)}_URL`, types: tables });
    } else if (s.info.kind === "openapi") {
      const types: Record<string, HttpTypeMapping> = {};
      for (const t of mine) {
        const e = model.entity(t.entity)!;
        const get = s.operations.find((o) => o.role === "get" && o.entity === e.id);
        const list = s.operations.find((o) => o.role === "list" && o.entity === e.id);
        if (!get || !list) {
          notes.push(`${t.name} cannot be read from ${s.info.system}: it ${get ? "lists" : "gets"} no ${e.name}`);
          continue;
        }
        const pointerOf = (field: string) => e.fields.find((f) => f.id === field)!.pointer!;
        const params: Record<string, string> = {};
        for (const q of list.queryParams) {
          const prop = q.field ? t.properties.find((x) => x.field === e.fields.find((f) => f.name === q.field)!.id) : undefined;
          if (prop) params[prop.name] = q.name;
        }
        types[t.name] = {
          get: (s.info.basePath ?? "") + get.path.replace(`{${get.pathParams.at(-1)}}`, "{id}"),
          ...(get.record ? { record: get.record } : {}),
          list: { path: (s.info.basePath ?? "") + list.path, items: list.items ?? "", ...(list.pages ? { pages: list.pages } : {}), ...(Object.keys(params).length ? { params } : {}) },
          id: pointerOf(t.properties.find((x) => x.name === t.key)!.field),
          fields: Object.fromEntries(t.properties.map((x) => [x.name, pointerOf(x.field)]))
        };
      }
      const scopes = [...new Set(s.operations.filter((o) => o.entity && mine.some((t) => t.entity === o.entity) && (o.role !== "command" || p.actions.some((a) => a.operation === o.id))).flatMap((o) => o.scopes))];
      const auth = s.auth?.kind === "client-credentials" && s.auth.tokenUrl
        ? { auth: { kind: "client-credentials" as const, tokenPath: s.auth.tokenUrl, clientIdEnv: `${env(s.info.id)}_CLIENT_ID`, clientSecretEnv: `${env(s.info.id)}_CLIENT_SECRET`, scope: scopes.join(" ") } }
        : s.auth?.kind === "api-key" && s.auth.header
          ? { auth: { kind: "header" as const, name: s.auth.header, valueEnv: `${env(s.info.id)}_API_KEY` } }
          : s.auth?.kind === "basic"
            ? { auth: { kind: "basic" as const, usernameEnv: `${env(s.info.id)}_CLIENT_ID`, passwordEnv: `${env(s.info.id)}_CLIENT_SECRET` } }
            : {};
      adapters.push({ kind: "http", dataSourceId: s.info.id, system: s.info.system, baseUrlEnv: `${env(s.info.id)}_BASE_URL`, ...auth, types, actions: httpActions.get(s.info.id) ?? {} });
    } else {
      notes.push(`${s.info.system} is described by JSON Schema only: its Types are proposed, and a deployment supplies the adapter that reads them`);
    }
  }

  return { manifest: { domain: p.domain, types, actions, dataSources, mappings }, adapters, policies: [...policies].sort(), notes };
}

/** What making adapters needs from a deployment: secrets by variable name, and a pool per Postgres source. */
export interface AdapterEnvironment {
  readonly secret: (name: string) => string | undefined;
  readonly pool?: (dataSourceId: string, connectionString: string) => Pool;
  readonly fetch?: typeof fetch;
}

/** The adapters an `AdapterPlan` describes, with its credentials read from the environment now. A missing one is an error naming the variable. */
/**
 * Where the client secret is posted. The token path comes from the collected
 * OpenAPI document, which is the service's word, not the deployment's: an
 * absolute URL there could send the secret anywhere. So it must be on the
 * base URL's origin, which the deployment set (M3 review M5).
 */
function tokenUrlFor(source: string, tokenPath: string, baseUrl: string): string {
  const url = new URL(tokenPath, baseUrl);
  if (url.origin !== new URL(baseUrl).origin) throw new Error(`${source}'s token endpoint ${url.origin} is not on its base URL's origin; the client secret is sent only there`);
  return url.href;
}

export function adaptersFor(plans: readonly AdapterPlan[], environment: AdapterEnvironment): (PostgresTableAdapter | HttpAdapter)[] {
  const need = (name: string) => {
    const v = environment.secret(name);
    if (!v) throw new Error(`${name} is not set`);
    return v;
  };
  return plans.map((plan) => {
    if (plan.kind === "postgres-table") {
      if (!environment.pool) throw new Error(`${plan.dataSourceId} is a PostgreSQL source and no pool factory was given`);
      return new PostgresTableAdapter(environment.pool(plan.dataSourceId, need(plan.connectionEnv)), { dataSourceId: plan.dataSourceId, system: plan.system, types: plan.types });
    }
    const baseUrl = need(plan.baseUrlEnv);
    const auth =
      plan.auth?.kind === "client-credentials"
        ? { kind: "client-credentials" as const, tokenUrl: tokenUrlFor(plan.dataSourceId, plan.auth.tokenPath, baseUrl), clientId: need(plan.auth.clientIdEnv), clientSecret: need(plan.auth.clientSecretEnv), ...(plan.auth.scope ? { scope: plan.auth.scope } : {}) }
        : plan.auth?.kind === "header"
          ? { kind: "header" as const, name: plan.auth.name, value: need(plan.auth.valueEnv) }
          : plan.auth?.kind === "basic"
            ? { kind: "header" as const, name: "authorization", value: `Basic ${Buffer.from(`${need(plan.auth.usernameEnv)}:${need(plan.auth.passwordEnv)}`).toString("base64")}` }
            : undefined;
    return new HttpAdapter({ dataSourceId: plan.dataSourceId, system: plan.system, baseUrl, ...(auth ? { auth } : {}), types: plan.types, actions: plan.actions, ...(environment.fetch ? { fetch: environment.fetch } : {}) });
  });
}
