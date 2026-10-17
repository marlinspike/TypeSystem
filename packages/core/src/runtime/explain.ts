import type { Identity } from "../model/policy.js";
import type { SemanticQuery } from "../model/query.js";

export const EXPLANATION_FORMAT = "typesys.explanation/1";

/** What an explanation is asked about (ADR-0089). */
export type ExplainQuestion =
  /** Reading one object: the object, each of its values, computed values included. */
  | { readonly kind: "read"; readonly type: string; readonly id: string }
  /** Traversing one relationship of one object. */
  | { readonly kind: "relationship"; readonly type: string; readonly id: string; readonly relationship: string }
  /** Invoking an Action with this input: authorization, target, input, preconditions. Nothing is executed. */
  | { readonly kind: "invoke"; readonly action: string; readonly input: unknown }
  /** Running a query: why it fails, or which of the rows the investigator is returned the subject is not. */
  | { readonly kind: "query"; readonly query: SemanticQuery };

export interface ExplainOptions {
  /**
   * Whose access to explain. Omitted, the investigator's own. Explaining
   * anyone else's needs the inspection policy (ADR-0088).
   */
  readonly as?: Identity;
}

/**
 * How a statement is known (ADR-0089): from the definitions alone, decided
 * now by the runtime for this question, or read from the audit log of
 * earlier calls.
 */
export type Basis = "structural" | "evaluated" | "observed";

/** Which control a finding is about, in the order the runtime applies them. */
export type Control =
  | "discovery"
  | "classification"
  | "object-policy"
  | "member-policy"
  | "derivation"
  | "release"
  | "audience"
  | "action-policy"
  | "target"
  | "input"
  | "precondition"
  | "source"
  | "row-plan"
  | "relationship";

/**
 * `not-told`: the investigator may not read this themselves, so how it is
 * decided for the subject is not said (ADR-0089).
 */
export type FindingOutcome = "returned" | "withheld" | "no-value" | "allowed" | "refused" | "not-found" | "unavailable" | "invalid" | "dangling" | "truncated" | "not-told";

export interface Finding {
  /** What it is about: `airforce.Aircraft/AF86-0147`, `airforce.Aircraft/AF86-0147.maintenanceStatus`, an Action's name. */
  readonly about: string;
  /** The member, when it is about one. */
  readonly member?: string;
  readonly outcome: FindingOutcome;
  readonly basis: Basis;
  /** Absent when the investigator may not be told which control decided. */
  readonly control?: Control;
  /** Inspectors only: the policy that decided. */
  readonly policy?: string;
  /** Inspectors only: its rule as the engine describes it. */
  readonly rule?: string;
  /** The reason as the investigator may be told it: the engine's own for an inspector, what the subject would be told otherwise. */
  readonly reason?: string;
  /** For a derivation: the inputs that withhold it, or that it is released from. */
  readonly inputs?: readonly string[];
  /** Inspectors only, and only markings they are cleared to learn. */
  readonly markings?: readonly string[];
  /** Inspectors only: the source that failed. */
  readonly source?: string;
  /** Inspectors only: what would change the outcome, from the definitions. A suggestion, never a promise. */
  readonly remedy?: string;
  /** For a relationship's `returned` finding: how many related objects the subject was returned. */
  readonly count?: number;
}

/** An earlier decision about the same subject and resource, from the audit log. */
export interface ObservedDecision {
  readonly at: string;
  readonly operation?: string;
  readonly action: string;
  readonly member?: string;
  readonly decision: "allow" | "deny";
  readonly reason?: string;
}

export type ExplanationOutcome = "allowed" | "partial" | "refused" | "not-found" | "unavailable" | "invalid";

/**
 * Why an operation is allowed, refused, partly answered or unavailable for
 * one subject (ADR-0089), produced by running the operation as that subject
 * through the runtime's own decision path and keeping the decisions, never
 * the values. It explains this decision now; the runtime decides every call
 * again, and a later call can be decided differently.
 */
export interface Explanation {
  readonly format: typeof EXPLANATION_FORMAT;
  readonly question: ExplainQuestion;
  /** The subject whose access is explained. */
  readonly subject: string;
  /** The audience the subject reads for, if any (ADR-0067). */
  readonly audience?: string;
  readonly investigator: string;
  /** `inspector`: policy names, rules, markings and sources are shown. `caller`: only what the subject is told in a refusal. */
  readonly disclosure: "inspector" | "caller";
  readonly outcome: ExplanationOutcome;
  /** One sentence. */
  readonly summary: string;
  readonly findings: readonly Finding[];
  /** For an Action: what it declares it does if it runs (ADR-0005), and, for an inspector, the source its effect lands in. */
  readonly effects?: { readonly sideEffects: string; readonly idempotency: string; readonly auditRequired: boolean; readonly source?: string };
  /** Inspectors only: matching decisions from the audit log, newest first. */
  readonly observed: readonly ObservedDecision[];
  readonly caveat: string;
}

export const EXPLANATION_CAVEAT = "This explains the decision as it is made now. The runtime decides every call again, and a later call can be decided differently.";

/** One decision the runtime made while answering an explained question: what its audit row records, plus the policy name. Internal. */
export interface TraceEntry {
  readonly subjectId: string;
  readonly action: "read" | "invoke";
  readonly typeName: string;
  readonly objectId?: string;
  readonly propertyPath?: string;
  readonly actionName?: string;
  readonly allow: boolean;
  readonly reason?: string;
  readonly control?: string;
  readonly policy?: string;
  /** The subject's audience refused it, not the subject (ADR-0067). */
  readonly byAudience?: boolean;
  readonly markings?: readonly string[];
  readonly inputs?: readonly string[];
  readonly released?: readonly string[];
}

/** One-sentence summaries, kept short and deterministic. */
export function summarize(outcome: ExplanationOutcome, findings: readonly Finding[], subject: string): string {
  const withheld = findings.filter((f) => f.outcome === "withheld").map((f) => f.member ?? f.about);
  const refused = findings.find((f) => f.outcome === "refused");
  switch (outcome) {
    case "allowed":
      return `${subject} is allowed this, and nothing is withheld.`;
    case "partial":
      return `${subject} is allowed this, with ${withheld.length} value${withheld.length === 1 ? "" : "s"} withheld: ${withheld.join(", ")}.`;
    case "refused":
      return `${subject} is refused${refused?.control ? ` by ${refused.control}` : ""}${refused?.reason ? `: ${refused.reason}` : ""}.`;
    case "not-found":
      return `No such object: ${findings.find((f) => f.outcome === "not-found")?.about ?? ""}.`;
    case "unavailable":
      return `A source did not answer, so the operation could not complete.`;
    case "invalid":
      return `The request itself is invalid: ${findings.find((f) => f.outcome === "invalid")?.reason ?? ""}.`;
  }
}

const QUESTION_KINDS = new Set(["read", "relationship", "invoke", "query"]);
const isText = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 512;

/** What is wrong with an explain question's shape, or undefined: checked before anything is decided. */
export function explainShapeError(question: unknown, opts: { as?: unknown } = {}): string | undefined {
  if (opts.as !== undefined && (typeof opts.as !== "object" || opts.as === null || !isText((opts.as as { subjectId?: unknown }).subjectId))) return "as must be an identity with a subjectId";
  if (typeof question !== "object" || question === null || Array.isArray(question)) return "it must be an object";
  const q = question as Record<string, unknown>;
  if (typeof q.kind !== "string" || !QUESTION_KINDS.has(q.kind)) return "kind must be read, relationship, invoke or query";
  if ((q.kind === "read" || q.kind === "relationship") && (!isText(q.type) || !isText(q.id))) return `${q.kind} needs a type and an id`;
  if (q.kind === "relationship" && !isText(q.relationship)) return "relationship needs a relationship";
  if (q.kind === "invoke" && !isText(q.action)) return "invoke needs an action";
  if (q.kind === "query" && (typeof q.query !== "object" || q.query === null)) return "query needs a query";
  return undefined;
}
