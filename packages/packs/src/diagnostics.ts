/**
 * Why a pack cannot be built, trusted, installed or upgraded (ADR-0059).
 * Every check runs before anything is registered, and all of its findings
 * are reported together, so one attempt shows everything to fix.
 */
export type PackDiagnosticCode =
  /** The archive is malformed, or states requirements its contents do not have. */
  | "invalid-pack"
  /** The contents changed after the pack was built. */
  | "digest-mismatch"
  /** No valid signature by a trusted key. */
  | "untrusted"
  /** A signature by a trusted key id does not verify. */
  | "bad-signature"
  /** A pack it requires is not present. */
  | "missing-dependency"
  /** A pack it requires is present at a version outside the range. */
  | "version-conflict"
  /** Packs require each other in a cycle. */
  | "cycle"
  /** Two packs define the same Type, Action, data source, mapping or trait differently, or the same pack twice. */
  | "conflict"
  /** It names a Type, Action or data source that neither it nor anything it requires provides. */
  | "unresolved-reference"
  /** The deployment supplies no implementation for a binding key. */
  | "missing-binding"
  /** The deployment's policy engine has no rule by this name. */
  | "unknown-policy"
  /** The deployment supplies no adapter for a data source. */
  | "missing-adapter"
  /** The registry refused it when installed into a scratch registry. */
  | "registration-failed"
  /** An upgrade's version does not move as far as its contract changes need. */
  | "under-versioned"
  /** An installed pack that depends on this one would break. */
  | "dependent-broken";

export interface PackDiagnostic {
  readonly code: PackDiagnosticCode;
  /** The pack the finding is about. */
  readonly pack: string;
  /** The Type, Action, binding, policy, data source or pack it concerns. */
  readonly subject?: string;
  readonly message: string;
}

export class PackError extends Error {
  constructor(readonly diagnostics: readonly PackDiagnostic[]) {
    super(
      `${diagnostics.length} pack problem${diagnostics.length === 1 ? "" : "s"}:\n` +
        diagnostics.map((d) => `  [${d.code}] ${d.pack}${d.subject ? ` (${d.subject})` : ""}: ${d.message}`).join("\n")
    );
    this.name = "PackError";
  }
}
