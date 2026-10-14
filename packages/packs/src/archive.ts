import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import semver from "semver";
import {
  canonical,
  type ActionDefinition,
  type DataSource,
  type DomainManifest,
  type Mapping,
  type SemanticTypeSchema,
  type TraitDefinition,
  type TypeDefinition,
  type XComputed,
  type XRelationships
} from "@typesys/core";
import { PackError, type PackDiagnostic } from "./diagnostics.js";

export const PACK_FORMAT = "typesys.pack/1";

/** A Type as a pack carries it: data only, with its traits by name and its computed values by binding key. */
export interface PackType {
  readonly name: string;
  readonly version: string;
  readonly schema: SemanticTypeSchema;
  readonly extends?: string;
  readonly traits: readonly string[];
  readonly deprecated?: TypeDefinition["deprecated"];
  readonly aliases?: Record<string, string>;
}

/** An Action as a pack carries it: each precondition by binding key, never its function. */
export type PackAction = Omit<ActionDefinition, "preconditions"> & {
  readonly preconditions: readonly { readonly description: string; readonly bindingId: string }[];
};

export interface PackContents {
  readonly types: readonly PackType[];
  readonly traits: readonly TraitDefinition[];
  readonly actions: readonly PackAction[];
  readonly dataSources: readonly DataSource[];
  readonly mappings: readonly Mapping[];
}

/**
 * What a deployment must supply for a pack to run, derived from its
 * contents (never trusted from the archive): code by binding key, policy
 * rules by name, an adapter per data source, and the Types, Actions and data
 * sources it names but does not contain, which its dependencies must.
 */
export interface PackRequirements {
  readonly computed: readonly string[];
  readonly preconditions: readonly string[];
  readonly policies: readonly string[];
  readonly dataSources: readonly string[];
  readonly types: readonly string[];
  readonly actions: readonly string[];
}

export interface PackSignature {
  readonly keyId: string;
  readonly algorithm: "ed25519";
  /**
   * Base64 Ed25519 signature over the UTF-8 bytes of `digest`, or, when
   * `after` is present, of the canonical JSON of `{ digest, after }`.
   */
  readonly value: string;
  /**
   * The key ids that had already signed when this key signed, sorted, and
   * covered by this signature (ADR-0069): removing an earlier signature
   * cannot hide that it was there, so a revoked co-signer is still seen.
   */
  readonly after?: readonly string[];
}

/** What a signature signs: the digest, bound to the key ids that signed before it. */
export function signedMessage(digest: string, after?: readonly string[]): Buffer {
  return Buffer.from(after && after.length > 0 ? canonical({ digest, after: [...after] }) : digest, "utf8");
}

/**
 * A domain pack (ADR-0059): one JSON document, content-addressed by
 * `digest` and optionally signed, that installs with no network and no
 * code in it. Code a pack needs (computed values, preconditions) is named by
 * binding key and supplied by the deployment, as for a durable registry
 * store (ADR-0015).
 */
export interface PackArchive {
  readonly format: typeof PACK_FORMAT;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  /** Pack name to a semver range, e.g. `{ core: "^1.0.0" }`. */
  readonly requires: Readonly<Record<string, string>>;
  readonly contents: PackContents;
  readonly requirements: PackRequirements;
  /** `sha256:<hex>` over the canonical JSON of everything above. */
  readonly digest: string;
  readonly signatures?: readonly PackSignature[];
}

export interface PackDefinition {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly requires?: Readonly<Record<string, string>>;
  /** What the pack contains: the same manifests `registerDomain` takes. */
  readonly manifests: readonly DomainManifest[];
}

const NAME = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/;

/** Plain data, as it will be after a round trip through JSON. */
const data = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const sorted = (values: Iterable<string>): string[] => [...new Set(values)].sort();

function computedBindings(computed: XComputed | undefined): string[] {
  return Object.values(computed ?? {}).map((c) => c.binding);
}
/** The core Types' placeholder for a relationship no source backs until a domain declares one; nothing serves it. */
const ABSTRACT_SOURCE = "unresolved";

function relationshipSources(rels: XRelationships | undefined): string[] {
  return Object.values(rels ?? {})
    .map((r) => r.resolution.dataSourceId)
    .filter((id) => id !== ABSTRACT_SOURCE);
}
function relationshipTargets(rels: XRelationships | undefined): string[] {
  return Object.values(rels ?? {}).map((r) => r.target);
}

/** What `contents` needs from a deployment and from other packs. */
export function requirementsOf(contents: PackContents): PackRequirements {
  const traits = new Map(contents.traits.map((t) => [t.name, t]));
  const own = { types: new Set(contents.types.map((t) => t.name)), actions: new Set(contents.actions.map((a) => a.name)) };
  const computed: string[] = [];
  const policies: string[] = [];
  const sources: string[] = [];
  const types: string[] = [];
  const actions: string[] = [];
  for (const t of contents.types) {
    const s = t.schema;
    computed.push(...computedBindings(s["x-computed"]));
    sources.push(...relationshipSources(s["x-relationships"]));
    types.push(...relationshipTargets(s["x-relationships"]));
    actions.push(...(s["x-actions"]?.actions ?? []));
    if (s["x-policy"]?.objectPolicy) policies.push(s["x-policy"].objectPolicy);
    policies.push(...Object.values(s["x-policy"]?.propertyPolicies ?? {}));
    if (t.extends) types.push(t.extends);
    for (const name of t.traits) {
      const trait = traits.get(name);
      computed.push(...computedBindings(trait?.computed));
      sources.push(...relationshipSources(trait?.relationships));
      types.push(...relationshipTargets(trait?.relationships));
      actions.push(...(trait?.actions?.actions ?? []));
    }
  }
  for (const a of contents.actions) {
    policies.push(a.authorizationPolicy);
    sources.push(a.implementation.dataSourceId);
    types.push(...a.applicableTypes, ...(a.target?.type ? [a.target.type] : []));
  }
  for (const m of contents.mappings) {
    sources.push(m.dataSourceId);
    types.push(m.typeName);
  }
  return {
    computed: sorted(computed),
    preconditions: sorted(contents.actions.flatMap((a) => a.preconditions.map((p) => p.bindingId))),
    policies: sorted(policies),
    dataSources: sorted(sources),
    types: sorted(types.filter((t) => !own.types.has(t))),
    actions: sorted(actions.filter((a) => !own.actions.has(a)))
  };
}

type Body = Omit<PackArchive, "digest" | "signatures">;

export function digestOf(body: Body): string {
  const { format, name, version, description, requires, contents, requirements } = body;
  return `sha256:${createHash("sha256").update(canonical({ format, name, version, description, requires, contents, requirements }), "utf8").digest("hex")}`;
}

/**
 * Builds a pack from domain manifests. Refuses a computed value or a
 * precondition with no binding key, since a pack carries no code, and two
 * different traits under one name.
 */
export function buildPack(def: PackDefinition): PackArchive {
  const problems: PackDiagnostic[] = [];
  const problem = (subject: string, message: string) => problems.push({ code: "invalid-pack", pack: def.name, subject, message });
  if (!NAME.test(def.name)) problem(def.name, "A pack name is lower case words joined by - or .");
  if (!semver.valid(def.version)) problem(def.version, "Not a semantic version");
  for (const [dep, range] of Object.entries(def.requires ?? {})) if (!semver.validRange(range)) problem(dep, `"${range}" is not a semver range`);

  const traits = new Map<string, TraitDefinition>();
  const types: PackType[] = [];
  const actions: PackAction[] = [];
  const dataSources: DataSource[] = [];
  const mappings: Mapping[] = [];
  for (const manifest of def.manifests) {
    for (const { schema, options } of manifest.types) {
      for (const trait of options.traits ?? []) {
        const seen = traits.get(trait.name);
        if (seen && canonical(data(seen)) !== canonical(data(trait))) problem(trait.name, "Two different traits share this name");
        traits.set(trait.name, trait);
      }
      for (const [prop, spec] of Object.entries(schema["x-computed"] ?? {})) if (!spec.binding) problem(`${options.name}.${prop}`, "A computed value needs a binding key");
      types.push(
        data({
          name: options.name,
          version: options.version,
          schema,
          ...(options.extends ? { extends: options.extends } : {}),
          traits: (options.traits ?? []).map((t) => t.name),
          ...(options.deprecated ? { deprecated: options.deprecated } : {}),
          ...(options.aliases ? { aliases: options.aliases } : {})
        })
      );
    }
    for (const action of manifest.actions ?? []) {
      const preconditions = (action.preconditions ?? []).map((p) => {
        if (!p.bindingId) problem(`${action.name}: ${p.description}`, "A precondition needs a bindingId");
        return { description: p.description, bindingId: p.bindingId ?? "" };
      });
      actions.push(data({ ...action, preconditions }));
    }
    dataSources.push(...data(manifest.dataSources ?? []));
    mappings.push(...data(manifest.mappings ?? []));
  }
  if (problems.length > 0) throw new PackError(problems);

  const contents: PackContents = { types, traits: data([...traits.values()]), actions, dataSources, mappings };
  const body: Body = { format: PACK_FORMAT, name: def.name, version: def.version, description: def.description, requires: { ...def.requires }, contents, requirements: requirementsOf(contents) };
  return { ...body, digest: digestOf(body) };
}

export type KeyInput = KeyObject | string;

/**
 * Adds an Ed25519 signature over the pack's digest and the key ids that
 * signed it before (ADR-0069). Signing never changes the digest.
 */
export function signPack(archive: PackArchive, keyId: string, privateKey: KeyInput): PackArchive {
  const key = typeof privateKey === "string" ? createPrivateKey(privateKey) : privateKey;
  const others = (archive.signatures ?? []).filter((s) => s.keyId !== keyId);
  const after = sorted(others.map((s) => s.keyId));
  const value = sign(null, signedMessage(archive.digest, after), key).toString("base64");
  return { ...archive, signatures: [...others, { keyId, algorithm: "ed25519", value, ...(after.length > 0 ? { after } : {}) }] };
}

/** Why and since when a key or a pack is no longer trusted (ADR-0069). */
export interface Revocation {
  /** ISO 8601. Recorded for the audit trail; a revocation applies to every pack, whenever it was signed. */
  readonly revokedAt?: string;
  readonly reason?: string;
  /**
   * The revoked key itself, for a key not among the trusted keys. A key is
   * revoked, not a name: whatever id the same public key is trusted under is
   * revoked with it.
   */
  readonly publicKey?: KeyInput;
}

export interface VerifyOptions {
  /** Key id to public key. When given, the pack must carry a valid signature by one of them. */
  readonly trustedKeys?: Readonly<Record<string, KeyInput>>;
  /**
   * Key ids no longer trusted (ADR-0069). A pack carrying any signature by
   * one is refused, whether or not trusted keys are given and whatever else
   * signed it: a signature by a compromised key says the pack passed
   * through its holder. A revoked key id in `trustedKeys` is not trusted.
   */
  readonly revokedKeys?: Readonly<Record<string, Revocation>>;
  /** Pack digests (`sha256:<hex>`, any case) no longer trusted, such as a release withdrawn for a defect (ADR-0069). */
  readonly revokedDigests?: Readonly<Record<string, Revocation>>;
}

/** What a pack's signatures say about who handled it: every key id that signed, and every one a signature says signed before it. */
export interface PackSigners {
  readonly name: string;
  readonly version: string;
  readonly digest: string;
  readonly keyIds: readonly string[];
}

export function signersOf(archive: PackArchive): PackSigners {
  const keyIds: unknown[] = (archive.signatures ?? []).flatMap((s): unknown[] => [s.keyId, ...(Array.isArray(s.after) ? (s.after as readonly unknown[]) : [])]);
  return { name: archive.name, version: archive.version, digest: archive.digest, keyIds: sorted(keyIds.filter((k): k is string => typeof k === "string")) };
}

const toKey = (key: KeyInput): KeyObject => (typeof key === "string" ? createPublicKey(key) : key);
const fingerprint = (key: KeyInput): string => createHash("sha256").update(toKey(key).export({ type: "spki", format: "der" })).digest("hex");
const own = <T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined => (record && Object.hasOwn(record, key) ? record[key] : undefined);

/**
 * Revoked keys by id, and by the fingerprint of each revoked key's public
 * key wherever it is known (from the revocation or the trusted keys), so a
 * key trusted under a second id is revoked under that one too.
 */
function revokedKeyOf(opts: Pick<VerifyOptions, "revokedKeys" | "trustedKeys">): (keyId: string) => Revocation | undefined {
  const byFingerprint = new Map<string, Revocation>();
  for (const [id, r] of Object.entries(opts.revokedKeys ?? {})) {
    const key = r.publicKey ?? own(opts.trustedKeys, id);
    if (key !== undefined) byFingerprint.set(fingerprint(key), r);
  }
  return (keyId) => {
    const direct = own(opts.revokedKeys, keyId);
    if (direct) return direct;
    const key = byFingerprint.size > 0 ? own(opts.trustedKeys, keyId) : undefined;
    return key === undefined ? undefined : byFingerprint.get(fingerprint(key));
  };
}

const normalDigest = (digest: string): string => digest.toLowerCase();

const revocationNote = (r: Revocation | undefined): string => [r?.revokedAt ? ` on ${r.revokedAt}` : "", r?.reason ? `: ${r.reason}` : ""].join("");

/**
 * The revocations that apply to `archive`: a withdrawn digest, and every
 * signature by a revoked key, verified or not, since an unverifiable
 * signature by a revoked key id is no reason to accept the pack either.
 */
export function revocationsOf(archive: PackArchive | PackSigners, opts: Pick<VerifyOptions, "revokedKeys" | "revokedDigests" | "trustedKeys">): PackDiagnostic[] {
  const signers = "keyIds" in archive ? archive : signersOf(archive);
  const out: PackDiagnostic[] = [];
  const digests = new Map(Object.entries(opts.revokedDigests ?? {}).map(([d, r]) => [normalDigest(d), r]));
  const revokedDigest = digests.get(normalDigest(signers.digest));
  if (revokedDigest) out.push({ code: "revoked", pack: signers.name, subject: signers.digest, message: `This build of ${signers.name} ${signers.version} was withdrawn${revocationNote(revokedDigest)}` });
  const revokedKey = revokedKeyOf(opts);
  for (const keyId of signers.keyIds) {
    const revoked = revokedKey(keyId);
    if (revoked) out.push({ code: "revoked", pack: signers.name, subject: keyId, message: `Signed by "${keyId}", a key revoked${revocationNote(revoked)}` });
  }
  return out;
}

function shapeProblems(a: Partial<PackArchive>): string[] {
  const out: string[] = [];
  if (a.format !== PACK_FORMAT) out.push(`format is not ${PACK_FORMAT}`);
  if (typeof a.name !== "string" || !NAME.test(a.name)) out.push("name is missing or malformed");
  if (typeof a.version !== "string" || !semver.valid(a.version)) out.push("version is not a semantic version");
  if (typeof a.digest !== "string") out.push("digest is missing");
  if (!a.requires || typeof a.requires !== "object") out.push("requires is missing");
  else for (const [dep, range] of Object.entries(a.requires)) if (typeof range !== "string" || !semver.validRange(range)) out.push(`requires.${dep} is not a semver range`);
  const c = a.contents as Partial<PackContents> | undefined;
  for (const k of ["types", "traits", "actions", "dataSources", "mappings"] as const) if (!Array.isArray(c?.[k])) out.push(`contents.${k} is not a list`);
  return out;
}

/**
 * Every reason not to trust `archive`: a malformed document, requirements
 * that do not match its contents, a digest that does not match, and, when
 * trusted keys are given, no valid signature by one of them; and any
 * revocation that applies (ADR-0069). Empty means it is intact (and, with
 * keys, from a trusted signer).
 */
export function verifyPack(archive: unknown, opts: VerifyOptions = {}): PackDiagnostic[] {
  const a = (archive ?? {}) as Partial<PackArchive>;
  const pack = typeof a.name === "string" ? a.name : "(unnamed)";
  const shape = shapeProblems(a);
  if (shape.length > 0) return shape.map((message) => ({ code: "invalid-pack", pack, message }));
  const full = a as PackArchive;
  const out: PackDiagnostic[] = [];
  if (canonical(requirementsOf(full.contents)) !== canonical(full.requirements))
    out.push({ code: "invalid-pack", pack, message: "The requirements it states are not the ones its contents need" });
  if (digestOf(full) !== full.digest) out.push({ code: "digest-mismatch", pack, message: "The digest does not match the contents: the pack was changed after it was built" });
  out.push(...revocationsOf(full, opts));
  if (opts.trustedKeys) {
    let trusted = false;
    const revokedKey = revokedKeyOf(opts);
    for (const s of full.signatures ?? []) {
      // Own keys only: a key id such as "constructor" names no trusted key.
      const key = own(opts.trustedKeys, s.keyId);
      if (key === undefined || revokedKey(s.keyId)) continue;
      const after = Array.isArray(s.after) ? s.after : undefined;
      if (s.algorithm === "ed25519" && verify(null, signedMessage(full.digest, after), toKey(key), Buffer.from(s.value, "base64"))) trusted = true;
      else out.push({ code: "bad-signature", pack, subject: s.keyId, message: `The signature by "${s.keyId}" does not verify` });
    }
    if (!trusted) out.push({ code: "untrusted", pack, message: "No valid signature by a trusted key" });
  }
  return out;
}
