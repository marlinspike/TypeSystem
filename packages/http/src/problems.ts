import {
  AdapterTimeoutError,
  AggregationNotSupportedError,
  AdapterUnavailableError,
  AuthorizationError,
  CircuitOpenError,
  ContractUnsatisfiedError,
  InvalidInputError,
  NotFoundError,
  PreconditionFailedError,
  RateLimitExceededError,
  SourceRefusedError
} from "@typesys/core";
import type { Response } from "express";
import { JournalConflictError, ReplayDivergenceError, WorkflowStateError } from "@typesys/workflow";

/** Every code a TypeSys API answers with. Stable: a client branches on these, never on a message. */
export type ProblemCode =
  | "forbidden"
  | "not-found"
  | "invalid-input"
  | "precondition-failed"
  | "rate-limited"
  | "conflict"
  | "workflow-diverged"
  | "unavailable"
  | "source-refused"
  | "contract-unsatisfied"
  | "not-supported"
  | "unauthorized"
  | "internal";

/**
 * An RFC 9457 problem, plus TypeSys's own `code`, and `reason` for a refusal
 * (the policy's, as the runtime audits it). `detail` is the error's own
 * message, which the runtime writes never to quote a value; an internal error
 * gets a fixed text instead, since its message was written for no caller.
 */
export interface Problem {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly code: ProblemCode;
  readonly detail: string;
  readonly reason?: string;
  readonly errors?: unknown;
}

type ErrorClass = abstract new (...args: never[]) => Error;
const MAPPING: readonly [ErrorClass, number, ProblemCode, string][] = [
  [AuthorizationError, 403, "forbidden", "Not authorized"],
  [NotFoundError, 404, "not-found", "Not found"],
  [InvalidInputError, 400, "invalid-input", "Invalid input"],
  [PreconditionFailedError, 422, "precondition-failed", "Precondition failed"],
  // The caller's contract names a Type at a version the model no longer has (ADR-0103): its precondition, unmet.
  [ContractUnsatisfiedError, 412, "contract-unsatisfied", "Contract not satisfied"],
  [RateLimitExceededError, 429, "rate-limited", "Rate limit exceeded"],
  // The Type's source cannot answer this kind of question (an aggregate): the request's to change, not a fault to retry.
  [AggregationNotSupportedError, 422, "not-supported", "Not supported"],
  [WorkflowStateError, 409, "conflict", "Conflict"],
  [JournalConflictError, 409, "conflict", "Conflict"],
  [ReplayDivergenceError, 409, "workflow-diverged", "Workflow definition diverged"],
  [AdapterTimeoutError, 503, "unavailable", "Source unavailable"],
  [AdapterUnavailableError, 503, "unavailable", "Source unavailable"],
  [CircuitOpenError, 503, "unavailable", "Source unavailable"],
  // The source refused TypeSystem's own credential (ADR-0072): a gateway failure, not the caller's refusal.
  [SourceRefusedError, 502, "source-refused", "Source refused"]
];

/**
 * The problem an error becomes; anything unrecognized is a 500 that says
 * nothing about itself. With `withholdReasons` (any discovery mode but
 * `open`, ADR-0068), a refusal says it was refused and not why: a policy's
 * reason can name the roles or attributes it wants, which is the model.
 */
export function toProblem(err: unknown, opts: { withholdReasons?: boolean } = {}): Problem {
  for (const [ErrorClass, status, code, title] of MAPPING) {
    if (err instanceof ErrorClass) {
      const reason = err instanceof AuthorizationError && !opts.withholdReasons ? err.reason : undefined;
      const errors = err instanceof InvalidInputError ? err.errors : err instanceof ContractUnsatisfiedError ? err.mismatches : undefined;
      return {
        type: `https://typesys.dev/problems/${code}`,
        title,
        status,
        code,
        detail: err.message,
        ...(reason !== undefined ? { reason } : {}),
        ...(errors !== undefined ? { errors } : {})
      };
    }
  }
  return { type: "https://typesys.dev/problems/internal", title: "Internal error", status: 500, code: "internal", detail: "Internal error" };
}

const plain = (status: number, code: ProblemCode, title: string, detail: string): Problem => ({ type: `https://typesys.dev/problems/${code}`, title, status, code, detail });

/** A bearer token the identity resolver refused: expired, badly signed, or for someone else. */
export const unauthorized = (): Problem => plain(401, "unauthorized", "Not authenticated", "The bearer token was not accepted");

/** No bearer token, on a server that requires one (ADR-0116). */
export const unauthenticated = (): Problem => plain(401, "unauthorized", "Not authenticated", "Sign in: send Authorization: Bearer <token> from the deployment's identity provider");

/** The identity provider could not be asked about the token (ADR-0116): the server's problem, retryable. */
export const identityUnavailable = (): Problem => plain(503, "unavailable", "Identity provider unavailable", "The token could not be checked: the identity provider could not be reached");

/** A route the API does not serve. */
export const notFound = (): Problem => plain(404, "not-found", "Not found", "No such route");

/** The problem for a request body Express could not read (malformed JSON, too large), or `undefined` for any other error. */
export function bodyProblem(err: unknown): Problem | undefined {
  const { type, status } = (err ?? {}) as { type?: unknown; status?: unknown };
  if (typeof type !== "string" || typeof status !== "number" || status < 400 || status >= 500) return undefined;
  if (type === "entity.parse.failed") return plain(400, "invalid-input", "Invalid input", "The request body is not valid JSON");
  if (type === "entity.too.large") return plain(413, "invalid-input", "Invalid input", "The request body is too large");
  return plain(status, "invalid-input", "Invalid input", "The request body could not be read");
}

/** Writes a problem as `application/problem+json`. */
export function sendProblem(res: Response, problem: Problem): void {
  res.status(problem.status).type("application/problem+json").send(JSON.stringify(problem));
}
