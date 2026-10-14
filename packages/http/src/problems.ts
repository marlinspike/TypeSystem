import {
  AdapterTimeoutError,
  AdapterUnavailableError,
  AuthorizationError,
  CircuitOpenError,
  InvalidInputError,
  NotFoundError,
  PreconditionFailedError,
  RateLimitExceededError
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
  [RateLimitExceededError, 429, "rate-limited", "Rate limit exceeded"],
  [WorkflowStateError, 409, "conflict", "Conflict"],
  [JournalConflictError, 409, "conflict", "Conflict"],
  [ReplayDivergenceError, 409, "workflow-diverged", "Workflow definition diverged"],
  [AdapterTimeoutError, 503, "unavailable", "Source unavailable"],
  [AdapterUnavailableError, 503, "unavailable", "Source unavailable"],
  [CircuitOpenError, 503, "unavailable", "Source unavailable"]
];

/** The problem an error becomes; anything unrecognized is a 500 that says nothing about itself. */
export function toProblem(err: unknown): Problem {
  for (const [ErrorClass, status, code, title] of MAPPING) {
    if (err instanceof ErrorClass) {
      const reason = err instanceof AuthorizationError ? err.reason : undefined;
      const errors = err instanceof InvalidInputError ? err.errors : undefined;
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
