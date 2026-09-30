import type { CedarValueJson, EntityJson, EntityUidJson } from "@cedar-policy/cedar-wasm/nodejs";
import type { PolicyRequest } from "@typesys/core";

/** Every principal is a `TypeS::User`, a member of one `TypeS::Role` per role, and every policy name a `TypeS::Action` (ADR-0031). */
export const PRINCIPAL_TYPE = "TypeS::User";
export const ROLE_TYPE = "TypeS::Role";
export const ACTION_TYPE = "TypeS::Action";

/** The resource id of a type-level request — one about every instance at once (ADR-0030), which carries no attributes. */
export const TYPE_LEVEL_RESOURCE_ID = "*";

/** The attribute names the schema declares, per fully qualified entity type: the allow-list of what a policy can see. */
export type AttributeIndex = ReadonlyMap<string, ReadonlySet<string>>;

/** A TypeS type name becomes a Cedar entity type, namespace for namespace: `hospital.Patient` → `hospital::Patient`. */
export function cedarEntityType(typeName: string): string {
  return typeName.split(".").join("::");
}

/** Plain JSON data — what Cedar's entity format is written in. Anything else (a function, a class instance, a non-finite number) can't be handed to Cedar faithfully. */
function isJsonData(value: unknown): value is CedarValueJson {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonData);
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) return Object.values(value).every(isJsonData);
  return false;
}

/**
 * The schema-declared attributes of one entity, read as own properties. A
 * declared attribute that is `null` or missing is absent. Any other value
 * goes to Cedar as it is, and Cedar's schema check refuses the whole request
 * if it isn't the declared type — it is never quietly dropped, because a
 * dropped attribute would silently disable every `forbid` that reads it
 * (ADR-0031). A value that isn't JSON data throws, and so denies.
 */
function declaredAttributes(bag: Readonly<Record<string, unknown>> | undefined, declared: ReadonlySet<string> | undefined): Record<string, CedarValueJson> {
  const attrs: Record<string, CedarValueJson> = {};
  if (!bag || !declared) return attrs;
  for (const name of declared) {
    const value = Object.hasOwn(bag, name) ? bag[name] : undefined;
    if (value === null || value === undefined) continue;
    if (!isJsonData(value)) throw new TypeError(`attribute "${name}" is not JSON data, so Cedar can't be given it`);
    attrs[name] = value;
  }
  return attrs;
}

export interface CedarRequest {
  principal: EntityUidJson;
  action: EntityUidJson;
  resource: EntityUidJson;
  context: Record<string, never>;
  entities: EntityJson[];
}

/** The principal side of a request: the subject as a `TypeS::User` and its roles. Throws when a declared attribute can't be represented. */
export function toCedarPrincipal(request: PolicyRequest, attributeIndex: AttributeIndex): { principal: EntityUidJson; entities: EntityJson[] } {
  const { subject } = request;
  const principal = { type: PRINCIPAL_TYPE, id: subject.subjectId };
  const roles = [...new Set(subject.roles)].map((id) => ({ type: ROLE_TYPE, id }));
  return {
    principal,
    entities: [
      { uid: principal, attrs: declaredAttributes(subject.attributes, attributeIndex.get(PRINCIPAL_TYPE)), parents: roles },
      ...roles.map((uid) => ({ uid, attrs: {}, parents: [] }))
    ]
  };
}

/** The Cedar request for one TypeS decision, per ADR-0031's mapping table. Throws when a declared attribute can't be represented. */
export function toCedarRequest(request: PolicyRequest, attributeIndex: AttributeIndex): CedarRequest {
  const { resource } = request;
  const { principal, entities } = toCedarPrincipal(request, attributeIndex);
  const resourceType = cedarEntityType(resource.typeName);
  const resourceUid = { type: resourceType, id: resource.objectId ?? TYPE_LEVEL_RESOURCE_ID };

  return {
    principal,
    action: { type: ACTION_TYPE, id: request.policyName },
    resource: resourceUid,
    context: {},
    entities: [...entities, { uid: resourceUid, attrs: declaredAttributes(resource.attributes, attributeIndex.get(resourceType)), parents: [] }]
  };
}
