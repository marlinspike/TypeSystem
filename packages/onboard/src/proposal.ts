import type { JsonSchema2020 } from "@typesys/core";
import { digestOf, type SensitivityCategory, type SourceEntity, type SourceField, type SourceInfo, type SourceModel, type SourceOperation } from "./sources.js";

export const PROPOSAL_FORMAT = "typesys.onboarding/1";

/**
 * Where an item comes from (ADR-0076). `declared`: the source states it (a
 * primary key, a foreign key, a column's type). `derived`: a deterministic
 * rule over declared facts (a name in camelCase, a field whose name says it
 * holds a social security number). `inferred`: a model's reading of the
 * evidence (a relationship no constraint declares, a business name), which
 * an expert must approve before it means anything.
 */
export type Basis = "declared" | "derived" | "inferred";
export type Author = "baseline" | "model";

interface Item {
  /** Stable across runs: built from the evidence ids the item is about, never from its name. */
  readonly id: string;
  readonly cites: readonly string[];
  readonly basis: Basis;
  readonly author: Author;
  /** sha256 of the text of everything cited: a later run whose evidence differs asks for review again. */
  readonly fingerprint: string;
}

export interface ProposedProperty extends Item {
  readonly name: string;
  /** The source field (evidence id). */
  readonly field: string;
  readonly schema: JsonSchema2020;
  readonly required: boolean;
  readonly description?: string;
  /** Who wrote the description: the source's own documentation, or the model. */
  readonly describedBy?: "source" | "model";
}

export interface ProposedType extends Item {
  /** The source entity (evidence id). */
  readonly entity: string;
  /** Qualified: `mx.Aircraft`. */
  readonly name: string;
  readonly description?: string;
  readonly describedBy?: "source" | "model";
  /** The property holding the object id. */
  readonly key: string;
  readonly properties: readonly ProposedProperty[];
}

/**
 * A reference from one entity's field to another entity's key: `from`
 * holds the id of a `to` record. It becomes a to-one relationship on the
 * referencing Type (where its source can read a record's own field) and a
 * to-many one on the referenced Type.
 */
export interface ProposedRelationship extends Item {
  readonly from: string;
  readonly to: string;
  /** On the referencing Type: the one record referenced. */
  readonly name: string;
  /** On the referenced Type: every record referencing it. */
  readonly inverse: string;
  readonly description?: string;
}

export interface ProposedSensitive extends Item {
  readonly field: string;
  readonly category: SensitivityCategory;
  /** A classification marking the evidence states; the field is marked with it. */
  readonly marking?: string;
  readonly reason: string;
}

export interface ProposedAction extends Item {
  readonly operation: string;
  readonly name: string;
  readonly description: string;
}

export type FindingKind = "inconsistency" | "ambiguity" | "missing-key" | "unsupported" | "naming" | "data-quality";

export interface Finding extends Item {
  readonly kind: FindingKind;
  readonly severity: "error" | "warning" | "info";
  readonly message: string;
}

/** Something the model proposed that verification refused, and why. Kept for the reviewer, never applied. */
export interface Rejected {
  readonly kind: string;
  readonly item: unknown;
  readonly reason: string;
}

export interface Proposal {
  readonly format: typeof PROPOSAL_FORMAT;
  /** The namespace of every Type: `mx`. */
  readonly domain: string;
  readonly sources: readonly SourceInfo[];
  readonly types: readonly ProposedType[];
  readonly relationships: readonly ProposedRelationship[];
  readonly sensitive: readonly ProposedSensitive[];
  readonly actions: readonly ProposedAction[];
  readonly findings: readonly Finding[];
  readonly rejected: readonly Rejected[];
  /** The model call that refined it, when one did: what a reviewer needs to reproduce it. */
  readonly refinedBy?: { readonly model: string; readonly callId: string; readonly configDigest?: string; readonly requestDigest: string; readonly at: string };
}

// ------------------------------------------------------------------ naming

const parts = (s: string): string[] =>
  s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
export const pascal = (s: string): string =>
  parts(s)
    .map((p) => p[0]!.toUpperCase() + p.slice(1).toLowerCase())
    .join("");
export const camel = (s: string): string => {
  const p = pascal(s);
  return p ? p[0]!.toLowerCase() + p.slice(1) : p;
};
export const kebab = (s: string): string =>
  parts(s)
    .map((p) => p.toLowerCase())
    .join("-");
export const plural = (s: string): string => (/(s|x|ch|sh)$/i.test(s) ? `${s}es` : /[^aeiou]y$/i.test(s) ? `${s.slice(0, -1)}ies` : `${s}s`);
const singular = (s: string): string => (/ies$/i.test(s) ? `${s.slice(0, -3)}y` : /(ss|us)$/i.test(s) ? s : /s$/i.test(s) && s.length > 3 ? s.slice(0, -1) : s);

export const TYPE_LOCAL = /^[A-Z][A-Za-z0-9]*$/;
export const MEMBER = /^[a-z][A-Za-z0-9]*$/;
export const DOMAIN = /^[a-z][a-z0-9-]*$/;

/** The last segment of a source name, singular: `mx.wrk_ord` → `WrkOrd`, `Members` → `Member`. */
export const localTypeName = (entity: SourceEntity): string => pascal(singular(entity.name.split(".").at(-1)!));

// ------------------------------------------------------------------ baseline

/** The text of every cited evidence record, digested: what an approval is of. */
export function fingerprint(model: SourceModel, cites: readonly string[]): string {
  return digestOf([...new Set(cites)].sort().map((id) => [id, model.evidence.get(id)?.text ?? null]));
}

const item = (model: SourceModel, id: string, cites: readonly string[], basis: Basis, author: Author = "baseline") => ({ id, cites: [...new Set(cites)], basis, author, fingerprint: fingerprint(model, cites) });

/** The evidence about a field: the field, its entity, and any constraint on it. */
export function fieldCites(model: SourceModel, f: SourceField, entity: SourceEntity): string[] {
  const checks = [...model.evidence.keys()].filter((id) => id.startsWith(`${entity.id}#check:`) && new RegExp(`\\(\\(?${f.name}\\)?[ :]`).test(model.evidence.get(id)!.text));
  return [f.id, ...checks, ...(f.references ? [f.references.evidence] : [])];
}

/** A command operation as an Action, when it acts on one keyed entity whose key its path names. */
function commandTarget(model: SourceModel, op: SourceOperation): { entity: SourceEntity; param: string } | undefined {
  const entity = op.entity ? model.entity(op.entity) : undefined;
  if (op.role !== "command" || !entity?.key || op.pathParams.length !== 1) return undefined;
  return { entity, param: op.pathParams[0]! };
}

/**
 * The proposal TypeSystem makes with no model (ADR-0076): every entity with
 * a key as a Type, every field as a property under a mechanical name, every
 * declared foreign key as a relationship, every field whose name or
 * documentation says it is sensitive as sensitive, and every command an API
 * declares on one record as an Action. It invents nothing, so it is also
 * what onboarding falls back to when no model is configured.
 */
export function baseline(model: SourceModel, domain: string): Proposal {
  if (!DOMAIN.test(domain)) throw new Error(`Domain "${domain}" must be lower case letters, digits and "-"`);
  const types: ProposedType[] = [];
  const findings: Finding[] = [];
  const finding = (kind: FindingKind, severity: Finding["severity"], message: string, cites: string[]) =>
    findings.push({ ...item(model, `finding:${kind}:${digestOf([message, cites]).slice(7, 23)}`, cites, "derived"), kind, severity, message });
  const used = new Set<string>();
  for (const s of model.sources)
    for (const e of s.entities) {
      if (!e.key) {
        finding("missing-key", "warning", `${e.name} declares no key, so its records cannot be read one by one; it is left out until one is named`, [e.id]);
        continue;
      }
      let local = localTypeName(e);
      // Two sources may both have a `Member`: the second is qualified by its source.
      if (used.has(local)) local = `${pascal(s.info.id)}${local}`;
      used.add(local);
      const properties: ProposedProperty[] = [];
      const names = new Set<string>();
      for (const f of e.fields) {
        let name = camel(f.name);
        if (!MEMBER.test(name) || names.has(name)) name = `field${pascal(f.name)}${names.size}`;
        names.add(name);
        properties.push({
          ...item(model, `property:${f.id}`, fieldCites(model, f, e), "declared"),
          name,
          field: f.id,
          schema: f.schema,
          required: f.required || f.name === e.key,
          ...(f.description ? { description: f.description, describedBy: "source" as const } : {})
        });
        if (f.storage && !f.as && f.schema.type === "string" && !/char|text|uuid|name|citext/.test(f.storage) && !/^[a-z_]+\.[a-z_]+$/.test(f.storage)) {
          finding("unsupported", "info", `${e.name}.${f.name} is ${f.storage}, which onboarding reads as text`, [f.id]);
        }
      }
      types.push({
        ...item(model, `type:${e.id}`, [e.id, ...e.fields.filter((f) => f.name === e.key).map((f) => f.id)], "declared"),
        entity: e.id,
        name: `${domain}.${local}`,
        ...(e.description ? { description: e.description, describedBy: "source" as const } : {}),
        key: properties[e.fields.findIndex((f) => f.name === e.key)]!.name,
        properties
      });
    }

  const typeOf = new Map(types.map((t) => [t.entity, t]));
  const relationships: ProposedRelationship[] = [];
  for (const s of model.sources)
    for (const e of s.entities)
      for (const f of e.fields) {
        if (!f.references) continue;
        const from = typeOf.get(e.id);
        const to = typeOf.get(f.references.entity);
        if (!from || !to) continue;
        relationships.push({
          ...item(model, `relationship:${f.id}->${f.references.field}`, [f.id, f.references.field, f.references.evidence], "declared"),
          from: f.id,
          to: f.references.field,
          name: uniqueMember(camel(to.name.split(".")[1]!), from),
          inverse: uniqueMember(camel(plural(from.name.split(".")[1]!)), to),
          description: `${from.name.split(".")[1]} references ${to.name.split(".")[1]} by ${f.name}`
        });
      }

  const sensitive: ProposedSensitive[] = [];
  for (const s of model.sources)
    for (const e of s.entities) {
      if (!typeOf.has(e.id)) continue;
      for (const f of e.fields)
        for (const h of f.hints)
          sensitive.push({
            ...item(model, `sensitive:${f.id}:${h.category}`, [f.id], "derived"),
            field: f.id,
            category: h.category,
            ...(h.marking ? { marking: h.marking } : {}),
            reason: `${e.name}.${f.name}: ${h.reason}`
          });
    }

  const actions: ProposedAction[] = [];
  for (const s of model.sources)
    for (const op of s.operations) {
      if (op.role !== "command") continue;
      const t = commandTarget(model, op);
      if (!t || !typeOf.has(t.entity.id)) {
        finding("unsupported", "info", `${op.method} ${op.path} acts on no one record onboarding can name, so it is not proposed as an Action`, [op.id]);
        continue;
      }
      actions.push({
        ...item(model, `action:${op.id}`, [op.id, t.entity.id], "declared"),
        operation: op.id,
        name: pascal(op.operationId ?? `${op.method} ${op.path}`),
        description: op.summary ?? `${op.method} ${op.path}`
      });
    }
  for (const s of model.sources)
    for (const op of s.operations)
      for (const q of op.queryParams)
        if (!q.field && op.role === "list") finding("ambiguity", "info", `${op.method} ${op.path} filters by "${q.name}", which is no field of what it lists; queries on it are decided after reading`, [op.id]);

  return { format: PROPOSAL_FORMAT, domain, sources: model.sources.map((s) => s.info), types, relationships, sensitive, actions, findings, rejected: [] };
}

/** `name`, or `name2`, `name3`… where the Type already has a member called that. */
function uniqueMember(name: string, t: ProposedType): string {
  const taken = new Set(t.properties.map((p) => p.name));
  if (!taken.has(name)) return name;
  for (let i = 2; ; i++) if (!taken.has(`${name}${i}`)) return `${name}${i}`;
}
