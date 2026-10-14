import type { SemanticQuery } from "@typesys/core";

/**
 * A mission spec (`typesys.mission/1`, ADR-0071): what an application must
 * do, for whom, and how to tell that it does, written as checks the governed
 * runtime can decide. It is data, so an agent can write it, a person can
 * review it, and `plan`, `scaffold` and `verify` all read the same thing.
 */
export const MISSION_FORMAT = "typesys.mission/1";

/**
 * The model a mission composes over: a module whose export builds a host
 * (a runtime, its registry and its policy engine), and the resolver that
 * turns each caller's token into an identity. For a demonstration domain,
 * its testbed; for a deployment, its own wiring.
 */
export interface MissionHost {
  /** Module specifier, resolved from the application's directory. */
  readonly module: string;
  /** Export that builds the host: `async (options?) => { runtime, registry, policyEngine }`. */
  readonly build: string;
  /** Export that resolves a bearer token to an identity: `(token) => Identity`. */
  readonly identities: string;
  /** Optional export listing the workflow definitions the host already runs, so `plan` can say what exists. */
  readonly workflows?: string;
  /** Passed to `build`, as JSON. */
  readonly options?: Readonly<Record<string, unknown>>;
}

/** Someone the application serves, by the token they sign in with. */
export interface MissionCaller {
  readonly token: string;
  readonly description?: string;
}

/** `$input.<field>`, `$<step>.<field>`, or (in a compensation) `$output.<field>`; anything else is a literal. */
export type MissionValue = string | number | boolean | null;

export type MissionStep =
  | { readonly kind: "read"; readonly name: string; readonly type: string; readonly id: string; readonly description?: string }
  | {
      readonly kind: "check";
      readonly name: string;
      /** Two values that must be equal, or the run fails with `message`. */
      readonly equal: readonly [MissionValue, MissionValue];
      readonly message: string;
    }
  | {
      readonly kind: "approval";
      readonly name: string;
      readonly policy: string;
      /** Steps whose outputs the approver is shown, each as they may read it. */
      readonly present?: readonly string[];
      readonly allowSelfApproval?: boolean;
      readonly deadlineMs?: number;
    }
  | {
      readonly kind: "action";
      readonly name: string;
      readonly action: string;
      readonly input: Readonly<Record<string, MissionValue>>;
      readonly compensate?: { readonly action: string; readonly input: Readonly<Record<string, MissionValue>> };
    };

export interface MissionWorkflow {
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly startPolicy: string;
  readonly cancelPolicy?: string;
  /** Every input is a non-empty string. */
  readonly input: readonly string[];
  readonly steps: readonly MissionStep[];
}

/** A table of one Type, as each signed-in caller may read it. */
export interface MissionView {
  readonly name: string;
  readonly title: string;
  readonly type: string;
  readonly fields: readonly string[];
  readonly limit?: number;
}

/**
 * What must hold, decided by the runtime through the application's own API
 * as the named caller. Each kind is one question a client could ask.
 */
export type AcceptanceCheck = { readonly id: string; readonly as: string; readonly because?: string } & (
  | { readonly kind: "reads"; readonly type: string; readonly objectId: string; readonly sees?: readonly string[]; readonly withheld?: readonly string[] }
  | { readonly kind: "refused"; readonly type: string; readonly objectId: string }
  | { readonly kind: "query"; readonly query: SemanticQuery; readonly atLeast?: number; readonly atMost?: number }
  | { readonly kind: "offered"; readonly type: string; readonly objectId?: string; readonly action: string; readonly offered: boolean }
  | { readonly kind: "described"; readonly type: string; readonly described: boolean }
  | { readonly kind: "starts"; readonly workflow: string; readonly input: Readonly<Record<string, string>>; readonly status: string; readonly waitingOn?: string }
  | {
      readonly kind: "approves";
      readonly workflow: string;
      /** Who starts the run the check approves. */
      readonly startedBy: string;
      readonly input: Readonly<Record<string, string>>;
      readonly step: string;
      readonly admitted: boolean;
      /** When admitted, the run's status after approving. */
      readonly then?: string;
    }
);

export type AcceptanceKind = AcceptanceCheck["kind"];

export interface MissionSpec {
  readonly format: typeof MISSION_FORMAT;
  /** Lower case words joined by `-`: the application's name. */
  readonly name: string;
  /** The requirement in a person's words. */
  readonly requirement: string;
  readonly host: MissionHost;
  readonly callers: Readonly<Record<string, MissionCaller>>;
  /** Types and Actions the application uses; `plan` says which exist and who may see them. */
  readonly uses: { readonly types: readonly string[]; readonly actions?: readonly string[] };
  readonly workflow?: MissionWorkflow;
  readonly views?: readonly MissionView[];
  readonly acceptance: readonly AcceptanceCheck[];
}

/**
 * What an agent acts on: a stable `code`, where in the spec or the
 * application it is, what is wrong, and what would fix it.
 */
export interface EngineerDiagnostic {
  readonly code: string;
  readonly severity: "error" | "warning" | "info";
  /** JSON-pointer-like path into the spec (`acceptance/3`), or a file of the application. */
  readonly at: string;
  readonly message: string;
  readonly hint?: string;
}

const NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const STEP = /^[a-z][A-Za-z0-9]*$/;
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const VIEW = /^[A-Z][A-Za-z0-9]*$/;
const count = (v: unknown, min: number) => typeof v === "number" && Number.isSafeInteger(v) && v >= min;

/** `$head.field`, exactly one field deep; undefined for anything else that starts with `$`. */
export function parseRef(v: string): { head: string; field: string } | undefined {
  const m = /^\$([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(v);
  return m ? { head: m[1]!, field: m[2]! } : undefined;
}
const KINDS: readonly AcceptanceKind[] = ["reads", "refused", "query", "offered", "described", "starts", "approves"];

/**
 * Every structural problem with a mission document, before anything is
 * looked up in a model: shape, names, references between steps, callers
 * the checks name. Empty means `plan` can read it.
 */
export function missionProblems(doc: unknown): EngineerDiagnostic[] {
  const out: EngineerDiagnostic[] = [];
  const err = (at: string, message: string, hint?: string) => out.push({ code: "invalid-mission", severity: "error", at, message, ...(hint ? { hint } : {}) });
  const m = (doc ?? {}) as Partial<MissionSpec>;
  if (m.format !== MISSION_FORMAT) err("format", `format is not ${MISSION_FORMAT}`);
  if (typeof m.name !== "string" || !NAME.test(m.name)) err("name", "name must be lower case words joined by -", 'e.g. "component-replacement"');
  if (typeof m.requirement !== "string" || m.requirement.trim() === "") err("requirement", "requirement is missing");
  const h = m.host as Partial<MissionHost> | undefined;
  for (const k of ["module", "build", "identities"] as const) if (typeof h?.[k] !== "string" || h[k] === "") err(`host/${k}`, `host.${k} is missing`);
  const callers = m.callers && typeof m.callers === "object" ? m.callers : {};
  if (Object.keys(callers).length === 0) err("callers", "a mission names at least one caller");
  for (const [name, c] of Object.entries(callers)) if (typeof (c as Partial<MissionCaller>)?.token !== "string") err(`callers/${name}`, "a caller needs the token it signs in with");
  if (!Array.isArray(m.uses?.types)) err("uses/types", "uses.types is not a list");

  const w = m.workflow;
  if (w) {
    if (typeof w.name !== "string" || !/^[a-z][a-z0-9-]*\.[A-Z][A-Za-z0-9]*$/.test(w.name)) err("workflow/name", "a workflow name is qualified like a Type", 'e.g. "airforce.ReplaceComponent"');
    if (typeof w.startPolicy !== "string") err("workflow/startPolicy", "the workflow names no startPolicy");
    if (!Array.isArray(w.input) || w.input.some((i) => typeof i !== "string" || !IDENT.test(i))) err("workflow/input", "input is a list of field names, each an identifier");
    const seen = new Set<string>();
    for (const [i, s] of ((Array.isArray(w.steps) ? w.steps : []) as readonly (MissionStep | undefined)[]).entries()) {
      const at = `workflow/steps/${i}`;
      if (typeof s?.name !== "string" || !STEP.test(s.name)) err(`${at}/name`, "a step name is a camelCase word");
      else if (seen.has(s.name)) err(`${at}/name`, `step "${s.name}" is named twice`);
      const refs = (values: readonly MissionValue[], output = false) => {
        for (const v of values) {
          if (typeof v !== "string" || !v.startsWith("$")) continue;
          const ref = parseRef(v);
          if (!ref) {
            err(at, `"${v}" is not a reference to one field`, "write $input.<field>, $<step>.<field> or $output.<field>");
            continue;
          }
          const { head, field } = ref;
          if (head === "input") {
            if (Array.isArray(w.input) && !w.input.includes(field)) err(at, `"${v}" names an input the workflow does not take`, `add "${field}" to workflow.input`);
          } else if (head === "output") {
            if (!output) err(at, `"${v}": $output is the compensated Action's output, only in a compensation`);
          } else if (!seen.has(head)) err(at, `"${v}" names step "${head}", which does not come before this one`);
        }
      };
      if (s?.kind === "read") refs([s.id]);
      else if (s?.kind === "check") refs(Array.isArray(s.equal) ? s.equal : []);
      else if (s?.kind === "action") {
        refs(Object.values(s.input ?? {}));
        if (s.compensate) refs(Object.values(s.compensate.input ?? {}), true);
      } else if (s?.kind === "approval") {
        for (const p of s.present ?? []) if (!seen.has(p)) err(at, `the approval presents "${p}", which does not come before it`);
        if (s.deadlineMs !== undefined && !count(s.deadlineMs, 1)) err(`${at}/deadlineMs`, "deadlineMs is a whole number of milliseconds");
      } else err(`${at}/kind`, "a step is a read, check, approval or action");
      if (typeof s?.name === "string") seen.add(s.name);
    }
  }

  const viewNames = new Set<string>();
  for (const [i, v] of ((Array.isArray(m.views) ? m.views : []) as readonly (MissionView | undefined)[]).entries()) {
    const at = `views/${i}`;
    if (typeof v?.name !== "string" || !VIEW.test(v.name)) err(`${at}/name`, "a view name is a PascalCase word", 'e.g. "ComponentList"');
    else if (viewNames.has(v.name)) err(`${at}/name`, `view "${v.name}" is named twice`);
    else viewNames.add(v.name);
    if (typeof v?.title !== "string" || typeof v.type !== "string") err(at, "a view needs a title and a type");
    if (!Array.isArray(v?.fields) || v.fields.length === 0 || v.fields.some((f) => typeof f !== "string" || !IDENT.test(f))) err(`${at}/fields`, "a view lists at least one field, each an identifier");
    if (v?.limit !== undefined && !(count(v.limit, 1) && v.limit <= 1000)) err(`${at}/limit`, "limit is a whole number from 1 to 1000");
  }
  const approvals = new Set(((Array.isArray(w?.steps) ? w.steps : []) as readonly (MissionStep | undefined)[]).flatMap((s) => (s?.kind === "approval" ? [s.name] : [])));

  const ids = new Set<string>();
  for (const [i, c] of ((Array.isArray(m.acceptance) ? m.acceptance : []) as readonly (AcceptanceCheck | undefined)[]).entries()) {
    const at = `acceptance/${i}`;
    if (typeof c?.id !== "string" || c.id === "") err(`${at}/id`, "a check needs an id");
    else if (ids.has(c.id)) err(`${at}/id`, `check "${c.id}" is named twice`);
    else ids.add(c.id);
    if (!c || !KINDS.includes(c.kind)) err(`${at}/kind`, `a check is one of ${KINDS.join(", ")}`);
    const named: [string, unknown][] = [["as", c?.as], ...(c?.kind === "approves" ? ([["startedBy", c.startedBy]] as [string, unknown][]) : [])];
    for (const [field, who] of named) {
      // A check runs as someone the spec names: never, by omission, as nobody.
      if (typeof who !== "string" || !Object.hasOwn(callers, who)) err(at, `${field} ${typeof who === "string" ? `"${who}" is not one of the mission's callers` : "names no caller"}`, `name one of ${Object.keys(callers).join(", ")}`);
    }
    if ((c?.kind === "starts" || c?.kind === "approves") && c.workflow !== w?.name) err(at, `the check runs workflow "${c.workflow}", which the mission does not define`);
    if (c?.kind === "approves" && !approvals.has(c.step)) {
      const near = [...approvals][0];
      err(`${at}/step`, `"${c.step}" is not an approval step of the workflow`, near ? `the workflow's approvals are ${[...approvals].join(", ")}` : "the workflow has no approval step");
    }
    // A check with nothing to decide passes on any answer: each kind needs what it asserts.
    if (c?.kind === "reads" && !(c.sees?.length || c.withheld?.length)) err(at, "a reads check names fields the caller sees, or withheld, or both");
    if (c?.kind === "query" && c.atLeast === undefined && c.atMost === undefined) err(at, "a query check sets atLeast, atMost, or both");
    if (c?.kind === "query" && ((c.atLeast !== undefined && !count(c.atLeast, 0)) || (c.atMost !== undefined && !count(c.atMost, 0)))) err(at, "atLeast and atMost are whole numbers");
  }
  if (!Array.isArray(m.acceptance) || m.acceptance.length === 0) err("acceptance", "a mission has at least one acceptance check", "an application nothing can check is not done");
  return out;
}

/** The spec, or every reason it cannot be read. */
export function parseMission(doc: unknown): { spec: MissionSpec; diagnostics: [] } | { spec?: undefined; diagnostics: EngineerDiagnostic[] } {
  const diagnostics = missionProblems(doc);
  return diagnostics.length > 0 ? { diagnostics } : { spec: doc as MissionSpec, diagnostics: [] };
}
