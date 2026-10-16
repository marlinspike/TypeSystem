import type { EngineerDiagnostic } from "@typesys/engineer";

/**
 * A compiler diagnostic (ADR-0080): the engineering loop's shape, so one
 * agent reads both, with `because` for why it matters. `at` is a JSON
 * Pointer into `app.json` (`/flows/disposition/steps/3/input/lotId`), or a
 * file of the application.
 */
export interface AppDiagnostic extends EngineerDiagnostic {
  /** Why this is a problem: the rule it breaks, or what would go wrong at run time. */
  readonly because?: string;
}

export type Severity = AppDiagnostic["severity"];

/** Collects diagnostics, and refuses nothing: every problem is reported, not only the first. */
export class Diagnostics {
  readonly list: AppDiagnostic[] = [];

  add(code: string, at: string, message: string, extra: { hint?: string | undefined; because?: string | undefined; severity?: Severity } = {}): void {
    this.list.push({
      code,
      severity: extra.severity ?? "error",
      at,
      message,
      ...(extra.hint ? { hint: extra.hint } : {}),
      ...(extra.because ? { because: extra.because } : {})
    });
  }

  error(code: string, at: string, message: string, hint?: string, because?: string): void {
    this.add(code, at, message, { hint, because });
  }

  warn(code: string, at: string, message: string, hint?: string, because?: string): void {
    this.add(code, at, message, { hint, because, severity: "warning" });
  }

  info(code: string, at: string, message: string, hint?: string): void {
    this.add(code, at, message, { hint, severity: "info" });
  }

  get errors(): number {
    return this.list.filter((d) => d.severity === "error").length;
  }
}

/** `/flows/x/steps/0` from parts, each escaped as RFC 6901 says. */
export const pointer = (...parts: readonly (string | number)[]): string => `/${parts.map((p) => String(p).replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`;

/**
 * Every code the compiler reports, with what it means and how to resolve
 * it: what `typesys app explain <code>` prints, and what an agent reads
 * instead of the compiler's source.
 */
export const DIAGNOSTIC_CODES: Readonly<Record<string, { readonly meaning: string; readonly resolve: string }>> = {
  "invalid-app": { meaning: "The document is not a well-formed typesys.app/1 specification.", resolve: "Correct the field at `at`; `typesys app catalog` lists every primitive and its fields." },
  "invalid-name": { meaning: "A name does not follow its convention (pages PascalCase, steps and data camelCase, flows qualified).", resolve: "Rename it; names become identifiers in generated code." },
  "duplicate-name": { meaning: "Two things in one scope have the same name.", resolve: "Rename one; a reference must name exactly one thing." },
  "reserved-name": { meaning: "A data, state or step name is one of the reference scopes (input, state, params, me, row, item, output).", resolve: "Rename it." },
  "invalid-reference": { meaning: "A string starting with $ is not a reference of the form $scope.path.", resolve: "Write $scope.field, or { \"literal\": \"$…\" } for a string that starts with $." },
  "unknown-reference": { meaning: "A reference names a scope, data, state, step or parameter that does not exist where it is used.", resolve: "Name one in scope; the hint lists the nearest names." },
  "forward-reference": { meaning: "A step refers to a step that comes after it.", resolve: "Move the step, or refer to an earlier one: a flow runs in order." },
  "unknown-field": { meaning: "A path names a field the value does not have.", resolve: "Use one of the fields the hint lists; the model is the only schema." },
  "unknown-type": { meaning: "No Type of that name in the model.", resolve: "Use a Type the model describes; `typesys app catalog --model` lists them." },
  "unknown-relationship": { meaning: "The Type has no relationship of that name.", resolve: "Use one the hint lists, or add the relationship to the model." },
  "unknown-action": { meaning: "No Action of that name in the model.", resolve: "Use an Action the model describes." },
  "unknown-flow": { meaning: "An effect, form, assistant or check names a flow the application does not define.", resolve: "Define it under `flows`, or name one that is defined." },
  "unknown-page": { meaning: "A navigate effect or a screen check names a page that does not exist.", resolve: "Name one of the pages." },
  "unknown-model": { meaning: "An AI step names a model role the application does not declare, or the role names a model the LLM configuration lacks.", resolve: "Declare the role under `models`, with an id configured for runtime use in the LLM configuration." },
  "unknown-operator": { meaning: "An expression object names no known operator, or more than one.", resolve: "Use exactly one operator key; `typesys app catalog` lists them." },
  "type-mismatch": { meaning: "A value's type is not the type expected where it is used.", resolve: "Use a value of the expected type; nothing is converted for you." },
  "not-in-enum": { meaning: "A literal compared with, or given to, a field of fixed values is not one of them.", resolve: "Use one of the values the message lists." },
  "not-comparable": { meaning: "Two values of different types are compared, or ordered values are not numbers or dates.", resolve: "Compare values of one type; order only numbers and date-time strings." },
  "arity": { meaning: "An operator is given the wrong number of operands.", resolve: "Give it the operands the catalog lists." },
  "list-expected": { meaning: "An operator that works on a list is given something else.", resolve: "Give it a list: a query's data, a related read, or an include." },
  "list-path": { meaning: "A path continues through a list, which has no fields of its own.", resolve: "Use { \"pluck\": [list, \"field\"] }, { \"count\": list } or another list operator." },
  "maybe-skipped": { meaning: "A value comes from a step that may be skipped, where a value is required.", resolve: "Give the using step the same `when`, or wrap the value in { \"coalesce\": [value, default] }." },
  "missing-input": { meaning: "An Action, flow or form is not given an input it requires.", resolve: "Add the input." },
  "unknown-input": { meaning: "An Action, flow or form is given an input it does not take.", resolve: "Remove it, or use the input the hint names." },
  "cyclic-dependency": { meaning: "Data depend on each other in a cycle, so none can be read first.", resolve: "Break the cycle: one of them must depend only on state, parameters or other data." },
  "nondeterministic-in-flow": { meaning: "A flow uses a value that changes between runs (the current time).", resolve: "A flow's compute steps are replayed and compared; read the time in a step's input, or compute it in the interface." },
  "unsupported": { meaning: "The construct is not supported in that position.", resolve: "The message says what to do instead." },
  "unreviewed-ai-output": { meaning: "An Action with side effects uses an AI step's output with no approval of that output in between (the workflow engine's rule, ADR-0057).", resolve: "Add an approval step that presents the AI step, before the Action." },
  "unconfirmed-effect": { meaning: "An interface invokes an Action that changes a system without the preview and confirmation every such Action gets.", resolve: "Remove `confirm: false`: the person is shown the runtime's preview and confirms." },
  "retry-not-idempotent": { meaning: "A step retries an Action whose idempotency is none: a retry after a timeout may repeat the effect.", resolve: "Remove the retry, or make the Action idempotent in the model." },
  "uncompensated-action": { meaning: "A non-idempotent Action with side effects has no compensation, and a later step can fail.", resolve: "Declare `compensate`, or accept that a later failure leaves the effect in place." },
  "self-approval": { meaning: "An approval lets the run's initiator approve their own run.", resolve: "Remove allowSelfApproval unless the requirement says so." },
  "no-caller-admitted": { meaning: "No caller of the application is admitted by a policy the flow names, so nobody can start, approve or cancel it.", resolve: "Check the policy name, or add the caller the requirement means." },
  "model-not-runtime": { meaning: "An AI step's model is not configured for runtime use (ADR-0074).", resolve: "Use a model whose `uses` includes runtime." },
  "model-audience-blind": { meaning: "A model's audience is not told of a Type an AI step sends it, so the step will be refused at run time (or redacted).", resolve: "Grant the audience the Type in policy, or set release: \"redact\" if the requirement allows the model a partial view." },
  "query": { meaning: "The query is one the runtime refuses or that never matches (devkit's validateQuery, ADR-0056).", resolve: "The message says which part; `typesys check-query` explains more." },
  "unreachable-step": { meaning: "A step's condition is always false, so it never runs.", resolve: "Remove the step, or correct its condition." },
  "unused-data": { meaning: "Data are declared and never used, but would still be read.", resolve: "Remove them, or use them." },
  "page-param": { meaning: "A page's path and its params disagree.", resolve: "Declare one param per :segment of the path, and no other." },
  "invalid-check": { meaning: "An acceptance check is malformed or names something that does not exist.", resolve: "Correct the check; each one must be able to fail." },
  "edited-generated-file": { meaning: "A generated file was changed by hand since it was generated, and regenerating would discard the change.", resolve: "Move the change into src/extensions/ (or the spec), or compile with --force to discard it." },
  "extension-missing": { meaning: "The spec names an extension function or component whose module does not exist.", resolve: "Compile once to write a typed stub in src/extensions/, then implement it." },
  "compile-error": { meaning: "TypeScript refused the application: generated code no longer matches an extension, or an extension does not satisfy its contract.", resolve: "Fix the file at `at`: the generated contract in src/generated/contracts.ts says what the extension must provide." },
  "mission-translation": { meaning: "Something in a typesys.mission/1 spec has no exact typesys.app/1 equivalent.", resolve: "Review the translated spec at `at`." }
};
