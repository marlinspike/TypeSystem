import { missionProblems, parseRef, type MissionSpec, type MissionStep, type MissionValue, type MissionView } from "@typesys/engineer";
import type { AppDiagnostic } from "./diagnostics.js";
import { APP_FORMAT, type AppSpec, type Expr, type FlowInputIR, type FlowIR, type NodeIR, type PageIR, type StepIR } from "./ir.js";

export interface MigrationResult {
  /** The translated application; undefined when the mission itself is invalid. */
  readonly spec?: AppSpec;
  /**
   * The mission's own problems (`invalid-mission`, errors), and one
   * `mission-translation` note for everything the translation dropped,
   * added or could not say exactly, at its place in the mission.
   */
  readonly diagnostics: readonly AppDiagnostic[];
}

const kebab = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
const words = (name: string) => name.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
/** `ops.ConfirmSortie` → `confirmSortie`: a flow's key in the application. */
const flowKey = (name: string) => {
  const last = name.slice(name.lastIndexOf(".") + 1);
  return last.charAt(0).toLowerCase() + last.slice(1);
};

/**
 * A mission value as an expression. They mean the same thing: `$input.x`,
 * `$<step>.x` and `$output.x` are references in both languages, and a
 * literal is a literal. The one string that would change meaning is a
 * literal starting with `$`, which a mission refuses, so none reaches here.
 */
const expr = (v: MissionValue): Expr => v;
const exprs = (input: Readonly<Record<string, MissionValue>>) => Object.fromEntries(Object.entries(input).map(([k, v]) => [k, expr(v)]));

function step(s: MissionStep): StepIR {
  switch (s.kind) {
    case "read":
      return { kind: "read", name: s.name, ...(s.description ? { description: s.description } : {}), read: { kind: "object", type: s.type, id: expr(s.id) } };
    case "check":
      return { kind: "check", name: s.name, assert: { eq: [expr(s.equal[0]), expr(s.equal[1])] }, message: s.message };
    case "approval":
      return {
        kind: "approval",
        name: s.name,
        policy: s.policy,
        present: [...(s.present ?? [])],
        ...(s.allowSelfApproval ? { allowSelfApproval: true } : {}),
        ...(s.deadlineMs !== undefined ? { deadlineMs: s.deadlineMs } : {})
      };
    case "action":
      return { kind: "action", name: s.name, action: s.action, input: exprs(s.input), ...(s.compensate ? { compensate: { action: s.compensate.action, input: exprs(s.compensate.input) } } : {}) };
  }
}

function table(v: MissionView): NodeIR {
  return { kind: "table", id: `${kebab(v.name)}-table`, title: v.title, data: v.name.charAt(0).toLowerCase() + v.name.slice(1), columns: [...v.fields], search: true };
}

/**
 * Translates a `typesys.mission/1` spec into a `typesys.app/1` application
 * (ADR-0086). Everything a mission says has an equivalent, so the
 * translation is exact where it matters: the host, the callers, the
 * requirement, every acceptance check unchanged, and the workflow step for
 * step under the same names, so a check that names a step still finds it.
 *
 * What changes is said, never done silently:
 *
 * - `uses` has no field in an application, which reads what its pages and
 *   flows name; each Type or Action it listed that nothing uses is noted.
 * - A check step compares with `eq`, which the checker types: a mission
 *   that compared a string with a number now fails to compile instead of
 *   failing every run.
 * - The views become one page of tables, each with its own stable node id,
 *   and the workflow gains a form to start it and an approval queue, which
 *   the mission's API-only workflow did not have.
 */
export function missionToApp(doc: unknown): MigrationResult {
  const problems = missionProblems(doc);
  if (problems.some((p) => p.severity === "error")) return { diagnostics: problems.map((p) => ({ ...p, at: `/${p.at}` })) };
  const m = doc as MissionSpec;
  const notes: AppDiagnostic[] = [];
  const note = (at: string, message: string, hint?: string) => notes.push({ code: "mission-translation", severity: "info", at, message, ...(hint ? { hint } : {}) });

  let flows: Record<string, FlowIR> | undefined;
  const w = m.workflow;
  const key = w ? flowKey(w.name) : undefined;
  if (w && key) {
    // An input a read step looks up by id carries that Type's object id: the form offers a picker for it.
    const objectOf = new Map<string, string>();
    for (const s of w.steps) {
      if (s.kind !== "read" || typeof s.id !== "string") continue;
      const ref = parseRef(s.id);
      if (ref?.head === "input" && !objectOf.has(ref.field)) objectOf.set(ref.field, s.type);
    }
    const input: Record<string, FlowInputIR> = Object.fromEntries(
      w.input.map((f) => [f, { schema: { type: "string", minLength: 1 }, ...(objectOf.has(f) ? { objectOf: objectOf.get(f)! } : {}) } satisfies FlowInputIR])
    );
    flows = {
      [key]: {
        name: w.name,
        version: w.version,
        ...(w.description ? { description: w.description } : {}),
        startPolicy: w.startPolicy,
        ...(w.cancelPolicy ? { cancelPolicy: w.cancelPolicy } : {}),
        input,
        steps: w.steps.map(step)
      }
    };
    for (const [i, s] of w.steps.entries()) if (s.kind === "check") note(`/workflow/steps/${i}`, `check "${s.name}" is now { eq: [...] }, typed by the checker`, "two values of different types are a compile error, where the mission failed the run");
  }

  const views = m.views ?? [];
  const children: NodeIR[] = views.map((v) => ({ ...table(v), span: 12 }));
  if (w && key) {
    children.push({ kind: "form", id: `${kebab(key)}-form`, title: words(kebab(key)), flow: key, span: 6 });
    children.push({ kind: "approvals", id: "approvals", flows: [key], span: 6 });
    note("/workflow", `flow "${key}" gains a form to start it and an approval queue on the first page`, "the mission's workflow was reachable only through the API");
  }
  const pages: PageIR[] = [];
  if (children.length) {
    pages.push({
      name: views[0]?.name ?? "Home",
      title: views[0]?.title ?? words(m.name),
      path: "/",
      data: Object.fromEntries(views.map((v) => [v.name.charAt(0).toLowerCase() + v.name.slice(1), { kind: "query", query: { type: v.type, select: [...v.fields], limit: Number(v.limit ?? 50) } }])),
      layout: { kind: "grid", children }
    });
    if (views.length > 1) note("/views", `views ${views.map((v) => v.name).join(", ")} are tables on one page, ${views[0]!.name}, as the mission showed them`, "split them into pages with their own paths when they grow");
  } else {
    note("/views", "the mission has no views and no workflow: the application has no page", "add a page to app.json");
  }

  const named = JSON.stringify({ flows, pages });
  for (const [i, t] of m.uses.types.entries()) if (!named.includes(JSON.stringify(t))) note(`/uses/types/${i}`, `${t} is listed in uses and nothing in the application reads it`, "an application reads what its pages and flows name; checks may still name it");
  for (const [i, a] of (m.uses.actions ?? []).entries()) if (!named.includes(JSON.stringify(a))) note(`/uses/actions/${i}`, `Action ${a} is listed in uses and no step or effect invokes it`);

  const spec: AppSpec = {
    format: APP_FORMAT,
    name: m.name,
    title: words(m.name),
    requirement: m.requirement,
    host: m.host,
    callers: m.callers,
    ...(flows ? { flows } : {}),
    pages,
    acceptance: [...m.acceptance]
  };
  return { spec, diagnostics: [...problems.map((p) => ({ ...p, at: `/${p.at}` })), ...notes] };
}
