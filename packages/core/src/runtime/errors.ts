export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
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
