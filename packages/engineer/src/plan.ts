import { describeModel, type ActionDescription, type ModelDescription, type TypeDescription } from "@typesys/core";
import { didYouMean } from "@typesys/devkit";
import type { EngineerHost, ProvidedWorkflow, TokenResolver } from "./host.js";
import { ObjectNotFoundError, type Identity } from "@typesys/core";
import { missionProblems, parseRef, type AcceptanceCheck, type EngineerDiagnostic, type MissionSpec, type MissionValue } from "./mission.js";

/** Something the model already provides, and which of the mission's callers are told of it (ADR-0068). */
export interface Provided {
  readonly name: string;
  readonly describedTo: readonly string[];
}

/** A relationship of a Type the mission uses: how a client reaches related objects without a join of its own. */
export interface ProvidedRelationship {
  readonly from: string;
  readonly name: string;
  readonly target: string;
  readonly cardinality: string;
}

/** A file `scaffold` will write, and what it is for. */
export interface PlannedFile {
  readonly kind: "client-model" | "workflow" | "views" | "server" | "acceptance-tests" | "mission" | "build";
  readonly file: string;
  readonly detail: string;
}

/**
 * A semantic plan (ADR-0071): what the governed model already provides for
 * the mission, what the application must add, and every problem found, each
 * with a code and a fix hint. `ok` is false when any diagnostic is an error.
 */
export interface MissionPlan {
  readonly mission: string;
  readonly ok: boolean;
  readonly provided: {
    readonly types: readonly Provided[];
    readonly relationships: readonly ProvidedRelationship[];
    readonly actions: readonly Provided[];
    readonly workflows: readonly ProvidedWorkflow[];
  };
  readonly create: readonly PlannedFile[];
  readonly diagnostics: readonly EngineerDiagnostic[];
}

const membersOf = (t: TypeDescription): string[] => [...Object.keys(t.properties), ...t.computed.map((c) => c.name)];

/** Plans `spec` against the host's model, decided for each of the mission's callers. */
export async function planMission(spec: MissionSpec, host: EngineerHost, resolve: TokenResolver, workflows: readonly ProvidedWorkflow[] = []): Promise<MissionPlan> {
  const structural = missionProblems(spec);
  if (structural.length > 0)
    return { mission: typeof spec.name === "string" ? spec.name : "", ok: false, provided: { types: [], relationships: [], actions: [], workflows: [] }, create: [], diagnostics: structural };
  const out: EngineerDiagnostic[] = [];
  const diag = (code: string, at: string, message: string, hint?: string, severity: EngineerDiagnostic["severity"] = "error") =>
    out.push({ code, severity, at, message, ...(hint ? { hint } : {}) });

  // The whole model, as the application's author sees it; then what each caller is told of it.
  const model: ModelDescription = await describeModel(host.registry);
  const types = new Map(model.types.map((t) => [t.name, t]));
  const actions = new Map(model.actions.map((a) => [a.name, a]));
  const toldOf = new Map<string, { types: Set<string>; actions: Set<string> } | undefined>();
  for (const [name, caller] of Object.entries(spec.callers)) {
    try {
      const described = await host.runtime.describeModel(await resolve(caller.token));
      toldOf.set(name, { types: new Set(described.types.map((t) => t.name)), actions: new Set(described.actions.map((a) => a.name)) });
    } catch {
      toldOf.set(name, undefined);
      diag("caller-told-nothing", `callers/${name}`, `${name} is refused a description of the model`, "an anonymous caller is, under authenticated or need-to-know discovery", "info");
    }
  }
  const describedTo = (kind: "types" | "actions", name: string) => [...toldOf].filter(([, t]) => t?.[kind].has(name)).map(([c]) => c);

  const type = (name: string, at: string): TypeDescription | undefined => {
    const t = types.get(name);
    if (!t) {
      const near = didYouMean(name, types.keys());
      diag("unknown-type", at, `No Type "${name}" in the model`, near ? `did you mean "${near}"?` : "plan lists the Types the model provides");
    }
    return t;
  };
  const action = (name: string, at: string): ActionDescription | undefined => {
    const a = actions.get(name);
    if (!a) {
      const near = didYouMean(name, actions.keys());
      diag("unknown-action", at, `No Action "${name}" in the model`, near ? `did you mean "${near}"?` : undefined);
    }
    return a;
  };
  const field = (t: TypeDescription, name: string, at: string) => {
    if (!membersOf(t).includes(name)) {
      const near = didYouMean(name, membersOf(t));
      diag("unknown-field", at, `${t.name} has no field "${name}"`, near ? `did you mean "${near}"?` : `its fields are ${membersOf(t).join(", ")}`);
    }
  };
  const actionInput = (a: ActionDescription, input: Readonly<Record<string, MissionValue>>, at: string) => {
    const properties = Object.keys((a.inputSchema.properties as Record<string, unknown> | undefined) ?? {});
    for (const k of Object.keys(input)) {
      if (!properties.includes(k)) {
        const near = didYouMean(k, properties);
        diag("unknown-action-input", at, `Action ${a.name} takes no input "${k}"`, near ? `did you mean "${near}"?` : `it takes ${properties.join(", ")}`);
      }
    }
    for (const r of a.inputSchema.required ?? []) if (!Object.hasOwn(input, r)) diag("missing-action-input", at, `Action ${a.name} needs input "${r}"`, `add "${r}" to the step's input`);
  };

  for (const [i, name] of spec.uses.types.entries()) type(name, `uses/types/${i}`);
  for (const [i, name] of (spec.uses.actions ?? []).entries()) action(name, `uses/actions/${i}`);

  // A workflow: every Type it reads, field it names and Action it invokes exists, with the input that Action takes.
  const readTypes = new Map<string, TypeDescription>();
  const refFields = (values: readonly MissionValue[], at: string) => {
    for (const v of values) {
      const ref = typeof v === "string" ? parseRef(v) : undefined;
      const t = ref && readTypes.get(ref.head);
      if (t) field(t, ref.field, at);
    }
  };
  for (const [i, s] of (spec.workflow?.steps ?? []).entries()) {
    const at = `workflow/steps/${i}`;
    if (s.kind === "read") {
      const t = type(s.type, at);
      if (t) readTypes.set(s.name, t);
    } else if (s.kind === "check") refFields(s.equal, at);
    else if (s.kind === "action") {
      const a = action(s.action, at);
      if (a) actionInput(a, s.input, at);
      refFields(Object.values(s.input), at);
      if (s.compensate) {
        const c = action(s.compensate.action, `${at}/compensate`);
        if (c) actionInput(c, s.compensate.input, `${at}/compensate`);
      }
      if (a?.idempotency === "none" && !s.compensate) diag("uncompensated-action", at, `Action ${a.name} is not idempotent and the step declares no compensation`, "a failure after it leaves its effect in place; declare compensate", "warning");
    } else if (s.kind === "approval") {
      if (s.allowSelfApproval) diag("self-approval", at, `approval "${s.name}" lets the initiator approve their own run`, "remove allowSelfApproval unless the requirement says so", "warning");
    }
  }

  if (spec.workflow && workflows.some((w) => w.name === spec.workflow!.name))
    diag("workflow-exists", "workflow/name", `The host already runs a workflow named ${spec.workflow.name}`, "use it, or give the mission's workflow its own name");

  for (const [i, v] of (spec.views ?? []).entries()) {
    const t = type(v.type, `views/${i}`);
    if (t) for (const f of v.fields) field(t, f, `views/${i}`);
  }

  for (const [i, c] of spec.acceptance.entries()) {
    const at = `acceptance/${i}`;
    if (c.kind === "reads" || c.kind === "refused" || c.kind === "offered" || c.kind === "described") {
      const t = type(c.type, at);
      if (t && c.kind === "reads") for (const f of [...(c.sees ?? []), ...(c.withheld ?? [])]) field(t, f, at);
      if (c.kind === "offered") action(c.action, at);
      // A check that its caller cannot pass under this model's discovery is a contradiction in the spec, found now.
      if (t && c.kind === "reads" && toldOf.get(c.as) && !toldOf.get(c.as)!.types.has(c.type))
        diag("check-contradicts-model", at, `${c.as} is not told of ${c.type}, so "${c.id}" cannot pass`, "check the caller, or the requirement", "warning");
    } else if (c.kind === "query") type(c.query.type, at);
  }

  // Every object a check names exists: a negative check on an object nobody has holds for everyone (the review's M5).
  const identities = new Map<string, Identity>();
  for (const [name, caller] of Object.entries(spec.callers)) identities.set(name, await resolve(caller.token));
  for (const [i, c] of spec.acceptance.entries()) {
    const target = objectOf(c);
    if (!target || !types.has(target.type)) continue;
    const outcomes = await Promise.all(
      [...identities.values()].map((who) => host.runtime.getObject(target.type, target.objectId, who).then(() => "found" as const, (err: unknown) => (err instanceof ObjectNotFoundError ? ("missing" as const) : ("refused" as const))))
    );
    if (outcomes.includes("found")) continue;
    if (outcomes.includes("missing")) diag("unknown-object", `acceptance/${i}`, `No ${target.type} "${target.objectId}" exists`, "a check on an object nobody has holds for everyone; check the id");
    else diag("object-unconfirmed", `acceptance/${i}`, `No caller of the mission may read ${target.type} "${target.objectId}", so plan cannot confirm it exists`, "add a caller who may read it, so the check is about policy and not a missing object", "warning");
  }

  // A person the requirement names and no check covers is unchecked by construction (the review's L3).
  const covered = new Set(spec.acceptance.flatMap((c) => [c.as, ...(c.kind === "approves" ? [c.startedBy] : [])]));
  for (const name of Object.keys(spec.callers)) if (!covered.has(name)) diag("caller-unchecked", `callers/${name}`, `No check runs as ${name}`, "add a check for what this caller may and may not do", "warning");

  const create: PlannedFile[] = [
    { kind: "mission", file: "mission.json", detail: "the spec, as verified" },
    { kind: "client-model", file: "model.ts", detail: `the typed client model (@typesys/sdk) for ${spec.uses.types.length} Types` },
    ...(spec.workflow ? [{ kind: "workflow" as const, file: "workflow.ts", detail: `${spec.workflow.name}: ${spec.workflow.steps.map((s) => s.name).join(" → ")}` }] : []),
    ...(spec.views?.length ? [{ kind: "views" as const, file: "views.tsx", detail: spec.views.map((v) => v.name).join(", ") }] : []),
    { kind: "server", file: "server.ts", detail: "the governed HTTP API over the host, with the workflow registered" },
    { kind: "acceptance-tests", file: "acceptance.test.ts", detail: `${spec.acceptance.length} checks, run through the application's API as each caller` },
    ...(spec.views?.length ? [{ kind: "views" as const, file: "index.html", detail: "the page that loads the views" }] : []),
    { kind: "build", file: "tsconfig.json", detail: "how a person builds it; verify builds with its own options" }
  ];
  return {
    mission: spec.name,
    ok: !out.some((d) => d.severity === "error"),
    provided: {
      types: spec.uses.types.filter((t) => types.has(t)).map((t) => ({ name: t, describedTo: describedTo("types", t) })),
      relationships: spec.uses.types.flatMap((t) => (types.get(t)?.relationships ?? []).map((r) => ({ from: t, name: r.name, target: r.target, cardinality: r.cardinality }))),
      actions: (spec.uses.actions ?? []).filter((a) => actions.has(a)).map((a) => ({ name: a, describedTo: describedTo("actions", a) })),
      workflows: [...workflows]
    },
    create,
    diagnostics: out
  };
}

/** The object a check reads, if it names one. */
function objectOf(c: AcceptanceCheck): { type: string; objectId: string } | undefined {
  if (c.kind === "reads" || c.kind === "refused") return { type: c.type, objectId: c.objectId };
  if (c.kind === "offered" && c.objectId !== undefined) return { type: c.type, objectId: c.objectId };
  return undefined;
}
