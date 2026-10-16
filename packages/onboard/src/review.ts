import { MEMBER, TYPE_LOCAL, type Proposal, type ProposedAction, type ProposedProperty, type ProposedRelationship, type ProposedSensitive, type ProposedType } from "./proposal.js";

export const REVIEW_FORMAT = "typesys.onboarding-review/1";

/**
 * An expert's decision on one proposal item (ADR-0076). It is of the item
 * as it was: its fingerprint, the digest of the evidence it cited. When the
 * evidence changes, the decision no longer applies and the item is asked
 * about again. The name approved is recorded, so a later run that names the
 * item differently does not rename what was approved.
 */
export interface Decision {
  readonly decision: "accept" | "reject";
  readonly fingerprint: string;
  /** The name approved: a Type's local name, a property's, a relationship's, an Action's. */
  readonly name?: string;
  /** A relationship's inverse name, approved. */
  readonly inverse?: string;
  readonly by: string;
  readonly at: string;
  readonly note?: string;
}

/** Every decision made on a domain's onboarding, kept beside it in version control. */
export interface Review {
  readonly format: typeof REVIEW_FORMAT;
  readonly domain: string;
  readonly decisions: Readonly<Record<string, Decision>>;
}

export interface PendingItem {
  readonly id: string;
  readonly kind: "type" | "property" | "relationship" | "sensitive" | "action";
  /** `new`: never decided. `changed`: decided, but on evidence that has since changed. */
  readonly reason: "new" | "changed";
  readonly summary: string;
}

export interface ReviewOutcome {
  /** Only what an expert accepted, under the names they approved, plus every sensitive flag they did not reject. */
  readonly approved: Proposal;
  /** What still needs a decision, and is not in `approved` (sensitive flags aside: they protect until rejected). */
  readonly pending: readonly PendingItem[];
  /** Decisions about items no longer proposed: their evidence is gone. */
  readonly orphaned: readonly string[];
}

/**
 * Applies a review to a proposal. Types, properties, relationships and
 * Actions are in the approved model only when accepted on their current
 * evidence: a model's reading is never approved by default, and an Action,
 * which has effects, never. A sensitive flag protects until an expert
 * rejects it. Re-running onboarding with the same review keeps everything
 * approved as it was and asks only about what is new or changed.
 */
export function applyReview(p: Proposal, review: Review): ReviewOutcome {
  if (review.format !== REVIEW_FORMAT) throw new Error(`The review is not ${String(REVIEW_FORMAT)}`);
  if (review.domain !== p.domain) throw new Error(`The review is for ${review.domain}, not ${p.domain}`);
  const pending: PendingItem[] = [];
  const decided = (id: string, fingerprint: string, kind: PendingItem["kind"], summary: string): Decision | undefined => {
    const d = review.decisions[id];
    if (!d) {
      pending.push({ id, kind, reason: "new", summary });
      return undefined;
    }
    if (d.fingerprint !== fingerprint) {
      pending.push({ id, kind, reason: "changed", summary });
      return undefined;
    }
    return d;
  };
  const accepted = (d: Decision | undefined): d is Decision => d?.decision === "accept";

  const types: ProposedType[] = [];
  for (const t of p.types) {
    const d = decided(t.id, t.fingerprint, "type", `Type ${t.name} from ${t.entity}`);
    const properties: ProposedProperty[] = [];
    for (const x of t.properties) {
      const pd = decided(x.id, x.fingerprint, "property", `${t.name}.${x.name} from ${x.field}`);
      if (accepted(pd)) properties.push(pd.name && MEMBER.test(pd.name) ? { ...x, name: pd.name } : x);
    }
    if (!accepted(d)) continue;
    const keyField = t.properties.find((x) => x.name === t.key)!.field;
    const key = properties.find((x) => x.field === keyField);
    if (!key) {
      pending.push({ id: t.id, kind: "type", reason: "new", summary: `${t.name} is accepted, but its key ${t.key} is not` });
      continue;
    }
    const local = d.name && TYPE_LOCAL.test(d.name) ? d.name : t.name.split(".")[1]!;
    types.push({ ...t, name: `${p.domain}.${local}`, key: key.name, properties });
  }
  const has = (field: string) => types.some((t) => t.properties.some((x) => x.field === field));

  const relationships: ProposedRelationship[] = [];
  for (const r of p.relationships) {
    const d = decided(r.id, r.fingerprint, "relationship", `${r.from} references ${r.to} (${r.basis}): ${r.name} / ${r.inverse}`);
    if (!accepted(d) || !has(r.from) || !has(r.to)) continue;
    relationships.push({ ...r, ...(d.name && MEMBER.test(d.name) ? { name: d.name } : {}), ...(d.inverse && MEMBER.test(d.inverse) ? { inverse: d.inverse } : {}) });
  }
  const sensitive: ProposedSensitive[] = [];
  for (const s of p.sensitive) {
    const d = review.decisions[s.id];
    const current = d && d.fingerprint === s.fingerprint ? d : undefined;
    if (!current) pending.push({ id: s.id, kind: "sensitive", reason: d ? "changed" : "new", summary: `${s.field}: ${s.category}${s.marking ? ` ${s.marking}` : ""} (${s.reason})` });
    if (current?.decision === "reject" || !has(s.field)) continue;
    sensitive.push(s);
  }
  const actions: ProposedAction[] = [];
  for (const a of p.actions) {
    const d = decided(a.id, a.fingerprint, "action", `Action ${a.name} from ${a.operation}`);
    if (accepted(d)) actions.push(d.name && TYPE_LOCAL.test(d.name) ? { ...a, name: d.name } : a);
  }
  const ids = new Set([...p.types.flatMap((t) => [t.id, ...t.properties.map((x) => x.id)]), ...p.relationships.map((r) => r.id), ...p.sensitive.map((s) => s.id), ...p.actions.map((a) => a.id)]);
  return {
    approved: { ...p, types, relationships, sensitive, actions },
    pending,
    orphaned: Object.keys(review.decisions).filter((id) => !ids.has(id))
  };
}

/** What an expert does to a proposal: accept or reject items, and rename them; everything else they leave pending. */
export interface ReviewActions {
  readonly by: string;
  readonly at?: string;
  /** Accept every item not otherwise decided (sensitive flags too). */
  readonly acceptRest?: boolean;
  readonly accept?: readonly string[];
  readonly reject?: Readonly<Record<string, string>>;
  /** Item id → the name approved instead (for a relationship, `name/inverse`). */
  readonly rename?: Readonly<Record<string, string>>;
}

/**
 * The review after an expert's actions on a proposal, merged into the
 * review they already had: earlier decisions on unchanged items stand.
 */
export function decide(p: Proposal, previous: Review | undefined, actions: ReviewActions): Review {
  const at = actions.at ?? new Date().toISOString();
  const decisions: Record<string, Decision> = { ...(previous?.decisions ?? {}) };
  const all: { id: string; fingerprint: string; name?: string; inverse?: string }[] = [
    ...p.types.flatMap((t) => [{ id: t.id, fingerprint: t.fingerprint, name: t.name.split(".")[1]! }, ...t.properties.map((x) => ({ id: x.id, fingerprint: x.fingerprint, name: x.name }))]),
    ...p.relationships.map((r) => ({ id: r.id, fingerprint: r.fingerprint, name: r.name, inverse: r.inverse })),
    ...p.sensitive.map((s) => ({ id: s.id, fingerprint: s.fingerprint })),
    ...p.actions.map((a) => ({ id: a.id, fingerprint: a.fingerprint, name: a.name }))
  ];
  const explicit = new Set([...(actions.accept ?? []), ...Object.keys(actions.reject ?? {}), ...Object.keys(actions.rename ?? {})]);
  for (const it of all) {
    const prior = decisions[it.id];
    const standing = prior && prior.fingerprint === it.fingerprint;
    const reject = actions.reject?.[it.id];
    const rename = actions.rename?.[it.id];
    if (reject !== undefined) {
      decisions[it.id] = { decision: "reject", fingerprint: it.fingerprint, by: actions.by, at, ...(reject ? { note: reject } : {}) };
      continue;
    }
    if (standing && !explicit.has(it.id)) continue;
    if (explicit.has(it.id) || actions.acceptRest) {
      const [name, inverse] = rename?.split("/") ?? [it.name, it.inverse];
      decisions[it.id] = { decision: "accept", fingerprint: it.fingerprint, by: actions.by, at, ...(name ? { name } : {}), ...(inverse ? { inverse } : {}) };
    }
  }
  return { format: REVIEW_FORMAT, domain: p.domain, decisions };
}

/**
 * A new proposal with what an expert already approved carried into it
 * (ADR-0076): an approved item whose evidence is unchanged stays, even
 * when this run did not propose it (no model this time, or a model that
 * left it out). What this run proposes anew is added for review; what the
 * approved model holds is never dropped or renamed by a later run. An
 * approved item whose evidence changed is carried in its new form by the
 * new proposal, and asked about again.
 */
export function carryForward(model: { readonly evidence: ReadonlyMap<string, unknown> }, approved: Proposal, next: Proposal): Proposal {
  const live = (cites: readonly string[]) => cites.every((c) => model.evidence.has(c));
  // The approved form of an item whose evidence is unchanged; otherwise this run's.
  const pick = <T extends { readonly id: string; readonly fingerprint: string }>(now: T, before: readonly T[]): T => {
    const b = before.find((x) => x.id === now.id);
    return b && b.fingerprint === now.fingerprint ? b : now;
  };
  const keep = <T extends { readonly id: string; readonly fingerprint: string; readonly cites: readonly string[] }>(now: readonly T[], before: readonly T[]): T[] => [
    ...now.map((x) => pick(x, before)),
    ...before.filter((x) => !now.some((y) => y.id === x.id) && live(x.cites))
  ];
  const types = next.types.map((t) => {
    const before = approved.types.find((x) => x.id === t.id);
    if (!before) return t;
    const base = before.fingerprint === t.fingerprint ? before : t;
    return { ...base, properties: keep(t.properties, before.properties) };
  });
  for (const t of approved.types) if (!types.some((x) => x.id === t.id) && live(t.cites)) types.push(t);
  return {
    ...next,
    types,
    relationships: keep(next.relationships, approved.relationships),
    sensitive: keep(next.sensitive, approved.sensitive),
    actions: keep(next.actions, approved.actions)
  };
}
