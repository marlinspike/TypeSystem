/**
 * A Cedar schema or policy set that cannot be trusted: it failed to parse,
 * failed strict validation, or breaks one of the engine's structural rules
 * (ADR-0031). Thrown at construction, so an untrustworthy engine is never
 * built. `details` carries Cedar's own messages, one per problem.
 */
export class CedarPolicyError extends Error {
  constructor(
    message: string,
    public readonly details: string[] = []
  ) {
    super(details.length > 0 ? `${message}:\n  - ${details.join("\n  - ")}` : message);
    this.name = "CedarPolicyError";
  }
}
