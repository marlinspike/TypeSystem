export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

/**
 * An object that no source holds (ADR-0048), raised only after the caller was
 * allowed to read an object of that Type, so a denied caller learns nothing
 * from it. A `NotFoundError`, so a caller that maps that class needs no
 * change. It carries the Type and id the caller supplied, and nothing stored.
 */
export class ObjectNotFoundError extends NotFoundError {
  constructor(
    public readonly typeName: string,
    public readonly objectId: string
  ) {
    super(`Not found: ${typeName}/${objectId}`);
    this.name = "ObjectNotFoundError";
  }
}

export class AuthorizationError extends Error {
  constructor(
    message: string,
    public readonly reason?: string
  ) {
    super(message);
    this.name = "AuthorizationError";
  }
}

/**
 * A query refused under `rowSecurity: "require-exact"` (ADR-0038): its read
 * policy has no exact plan for this subject, or an object the plan claimed
 * authorized was denied after the read. The message names the policy and
 * the limitation codes, never an attribute value.
 */
export class AuthorizationPlanError extends AuthorizationError {
  constructor(message: string) {
    super(message, message);
    this.name = "AuthorizationPlanError";
  }
}

export class PreconditionFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreconditionFailedError";
  }
}

export class RateLimitExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitExceededError";
  }
}

/** Caller-supplied input (a query, an Action's input) failed schema or limit validation. `errors` carries Ajv's detail when there is any. */
export class InvalidInputError extends Error {
  constructor(
    message: string,
    public readonly errors?: unknown
  ) {
    super(message);
    this.name = "InvalidInputError";
  }
}

/** A single adapter call exceeded its per-call deadline (ADR-0026); the call's `AbortSignal` was aborted. Retryable. */
export class AdapterTimeoutError extends Error {
  readonly retryable = true;
  constructor(message: string) {
    super(message);
    this.name = "AdapterTimeoutError";
  }
}

/** A data source could not be reached — connection pool exhausted, backend refused or reset the connection (ADR-0026). Retryable. */
export class AdapterUnavailableError extends Error {
  readonly retryable = true;
  constructor(message: string) {
    super(message);
    this.name = "AdapterUnavailableError";
  }
}

/** The circuit breaker for a data source is open, so the call failed fast without being attempted (ADR-0026). Not retryable. */
export class CircuitOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CircuitOpenError";
  }
}

/** A `runtime.aggregate()` was asked of a data source whose adapter does not implement `aggregate` (ADR-0027). */
export class AggregationNotSupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AggregationNotSupportedError";
  }
}

/** An adapter was asked to resolve a relationship strategy it doesn't implement (ADR-0028). */
export class UnsupportedResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedResolutionError";
  }
}
