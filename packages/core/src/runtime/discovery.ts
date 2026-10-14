import type { Identity } from "../model/policy.js";
import type { ActionDefinition } from "../model/action.js";
import type { TypeDefinition } from "../model/type.js";
import type { ActionDescription, ModelDescription, TypeDescription } from "../registry/model-description.js";

/**
 * Who may learn what the model is (ADR-0068), chosen per deployment:
 *
 * - `"open"`: anyone who can reach the transport gets the whole model.
 * - `"authenticated"`: any caller but an anonymous one gets the whole model.
 * - `"need-to-know"`: an authenticated caller gets the part of the model
 *   they could use: Types they may read some object of, the members of
 *   those they may read, relationships between Types they may read, the
 *   computed values over what they may read, and Actions they may invoke.
 */
export type Discovery = "open" | "authenticated" | "need-to-know";

export const DISCOVERY_MODES: readonly Discovery[] = ["open", "authenticated", "need-to-know"];

/** The subject an identity resolver gives a caller with no valid credentials (`@typesys/auth-oidc`, the demo resolvers). */
export const ANONYMOUS_SUBJECT_ID = "anonymous";

/** Whether this caller presented no credentials the resolver accepted: the anonymous subject, or no subject at all. */
export function isAnonymous(identity: Identity): boolean {
  const subjectId: unknown = identity.subjectId;
  return typeof subjectId !== "string" || subjectId === ANONYMOUS_SUBJECT_ID || subjectId.trim() === "";
}

/** A deprecation that names its successor only when the caller is told of it too. */
function deprecationWithin<D extends { readonly supersededBy?: string }>(deprecated: D | undefined, described: ReadonlySet<string>): D | undefined {
  if (!deprecated?.supersededBy || described.has(deprecated.supersededBy)) return deprecated;
  const { supersededBy: _withheld, ...rest } = deprecated;
  return rest as D;
}

/**
 * The questions need-to-know asks the runtime, each decided for the caller
 * (and their audience, ADR-0067) the way a read or an invocation would be,
 * without reading any object.
 */
export interface DiscoveryGate {
  /** The caller is cleared for the Type's markings and its read policy admits some object. */
  typeReadable(typeDef: TypeDefinition): Promise<boolean>;
  /** The caller is cleared for the member's markings and its own policy, if any, admits it on some object. */
  memberReadable(typeDef: TypeDefinition, member: string): Promise<boolean>;
  /** The Action's policy admits the caller on some object of the Type, and the caller is cleared for its Types. */
  actionInvocable(action: ActionDefinition, typeName: string): Promise<boolean>;
}

/** What need-to-know withheld, by count only: for the audit row, never for the caller. */
export interface Withheld {
  types: number;
  members: number;
  actions: number;
}

/**
 * The model narrowed to what one caller may use. Everything named in the
 * result is itself in the result: no relationship targets a withheld Type,
 * no computed value lists a withheld input, no Type extends a withheld one
 * and no alias points at a withheld member, so a description never reveals
 * the name of something it withholds.
 */
export async function narrowModel(
  model: ModelDescription,
  definitions: ReadonlyMap<string, TypeDefinition>,
  actionDefinitions: ReadonlyMap<string, ActionDefinition>,
  gate: DiscoveryGate
): Promise<{ model: ModelDescription; withheld: Withheld }> {
  const withheld: Withheld = { types: 0, members: 0, actions: 0 };
  const readable = new Set<string>();
  for (const type of model.types) {
    const def = definitions.get(type.name);
    if (def && (await gate.typeReadable(def))) readable.add(type.name);
    else withheld.types++;
  }

  const actions: ActionDescription[] = [];
  for (const action of model.actions) {
    const def = actionDefinitions.get(action.name);
    let invocable = false;
    for (const typeName of action.applicableTypes) {
      if (def && readable.has(typeName) && (await gate.actionInvocable(def, typeName))) {
        invocable = true;
        break;
      }
    }
    const target = action.target;
    if (invocable && (!target || readable.has(target.type))) actions.push({ ...action, applicableTypes: action.applicableTypes.filter((t) => readable.has(t)) });
    else withheld.actions++;
  }
  const invocable = new Set(actions.map((a) => a.name));
  for (const [i, a] of actions.entries()) {
    const { deprecated, ...rest } = a;
    const kept = deprecationWithin(deprecated, invocable);
    actions[i] = { ...rest, ...(kept ? { deprecated: kept } : {}) };
  }

  const types: TypeDescription[] = [];
  for (const type of model.types) {
    if (!readable.has(type.name)) continue;
    const def = definitions.get(type.name)!;
    const members = new Set<string>();

    const properties: TypeDescription["properties"] = {};
    for (const [name, schema] of Object.entries(type.properties)) {
      if (await gate.memberReadable(def, name)) {
        properties[name] = schema;
        members.add(name);
      } else withheld.members++;
    }

    const relationships: TypeDescription["relationships"] = [];
    for (const rel of type.relationships) {
      if (readable.has(rel.target) && (await gate.memberReadable(def, rel.name))) {
        relationships.push(rel);
        members.add(rel.name);
      } else withheld.members++;
    }

    // In declaration order, so a value computed over an earlier computed value sees whether that one was kept.
    const computed: TypeDescription["computed"] = [];
    const releases = new Map(def.computedProperties.map((cp) => [cp.name, new Set(cp.releases ?? [])]));
    for (const cp of type.computed) {
      const released = releases.get(cp.name) ?? new Set<string>();
      const inputsReadable = cp.dependsOn.every((dep) => members.has(dep) || released.has(dep));
      if (inputsReadable && (await gate.memberReadable(def, cp.name))) {
        computed.push({ ...cp, dependsOn: cp.dependsOn.filter((dep) => members.has(dep)) });
        members.add(cp.name);
      } else withheld.members++;
    }

    const aliases = Object.fromEntries(Object.entries(type.aliases ?? {}).filter(([, current]) => members.has(current)));
    const { extends: base, aliases: _all, deprecated, ...rest } = type;
    const kept = deprecationWithin(deprecated, readable);
    types.push({
      ...rest,
      ...(kept ? { deprecated: kept } : {}),
      ...(base && readable.has(base) ? { extends: base } : {}),
      properties,
      required: type.required.filter((r) => members.has(r)),
      computed,
      relationships,
      actions: type.actions.filter((a) => invocable.has(a)),
      ...(Object.keys(aliases).length > 0 ? { aliases } : {})
    });
  }
  return { model: { format: model.format, types, actions }, withheld };
}
