/**
 * Security profiles (ADR-0046): named, versioned sets of guarantees the
 * runtime checks at construction and refuses to start without. A version's
 * guarantees never change; a stricter set is a new version.
 */
export interface SecurityProfile {
  /** Stable, versioned id, e.g. `typesys:high-assurance:1`. */
  readonly id: string;
  /** What the profile guarantees, in words — the statement an assessor signs off on. */
  readonly guarantees: readonly string[];
}

export const HIGH_ASSURANCE_V1: SecurityProfile = Object.freeze({
  id: "typesys:high-assurance:1",
  guarantees: Object.freeze([
    'Row security is exact: rowSecurity is "require-exact", and a query whose authorization plan is not exact is refused.',
    "Aggregation over row-scoped data is admitted only by an exact plan the engine derived structurally from the rule it evaluates.",
    'Telemetry carries no raw subject, resource, or object identifiers: telemetryIdentity is "none" or pseudonymous, and span errors carry only their class name.',
    "Keys are managed: no adapter or cache reports local or unknown key management.",
    "No demonstration components: demonstration classification schemes are refused.",
    "Security configuration is well-formed: unknown options and malformed engines, schemes, or caches are refused.",
    'Engine faults in the audit log are enumerated: any fault but the combinators\' fixed form is recorded as "external-policy-fault".'
  ])
});

/** Every profile this runtime implements, by id. */
export const SECURITY_PROFILES: ReadonlyMap<string, SecurityProfile> = new Map([[HIGH_ASSURANCE_V1.id, HIGH_ASSURANCE_V1]]);

/** Where an encrypting component's keys come from (ADR-0046): a KMS, local material, or something it can't say. */
export type KeyManagement = "local" | "managed" | "unknown";

/**
 * How far a plan can be trusted without the per-object check (ADR-0046):
 * `"structural"` when the engine derived it from the same rule structure it
 * evaluates, by code it ships; anything else is `"unverified"`.
 */
export type PlanAssurance = "structural" | "unverified";

/** A runtime refused to start under a profile; every violation is listed. */
export class SecurityProfileError extends Error {
  constructor(
    readonly profile: string,
    readonly violations: readonly string[]
  ) {
    super(`Security profile ${profile} is not met:\n- ${violations.join("\n- ")}`);
    this.name = "SecurityProfileError";
  }
}
