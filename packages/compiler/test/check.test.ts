import { describe, expect, it } from "vitest";
import { checkApp } from "../src/check.js";
import { appProblems } from "../src/parse.js";
import { airforceEnv, squadronApp } from "./fixtures.js";

type App = ReturnType<typeof squadronApp>;
// The fixture is data: tests reach into it by path, as an agent's edit would.
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call */
const flowSteps = (a: App): any[] => (a as any).flows.ground.steps;
const layout = (a: App): any => (a as any).pages[0].layout;

describe("the application checker (ADR-0080)", () => {
  it("accepts the fixture, typing every step and every datum", async () => {
    const r = await checkApp(squadronApp(), await airforceEnv());
    expect(r.diagnostics).toEqual([]);
    expect(r.ok).toBe(true);
    const ground = r.flows.ground!;
    expect(ground.outputs.get("history")!.ty).toMatchObject({ t: "list", of: { t: "object", semantic: "airforce.MaintenanceEvent" } });
    expect(ground.outputs.get("poorParts")!.ty).toEqual({ t: "number", integer: true });
    expect(ground.reads).toEqual(["airforce.Aircraft", "airforce.Component", "airforce.MaintenanceEvent"]);
    expect(ground.writes).toEqual(["airforce.MaintenanceEvent", "airforce.WorkOrder"]);
    // The engine is told an Action runs after the approval before it, so its AI-review rule sees it.
    expect(ground.lowered.find((l) => l.engineName === "open")!.needs).toEqual(["leadApproval", "triage"]);
    expect(r.data.attention!.types).toEqual(["airforce.Aircraft"]);
    expect(r.pages[0]!.data.selectedAircraft!.deps.state).toEqual(["selected"]);
  });

  // Each case breaks the fixture in one place; the checker must report that place, with that code.
  const cases: [string, (a: App) => void, string, string][] = [
    ["a misspelt Type", (a) => ((a as any).data.attention.query.type = "airforce.Aircarft"), "unknown-type", "/data/attention/query/type"],
    ["a misspelt filter field", (a) => ((a as any).data.attention.query.filter.property = "needsAtention"), "unknown-field", "/data/attention/query/filter/property"],
    ["a filter value of the wrong type", (a) => ((a as any).data.attention.query.filter.value = "yes"), "type-mismatch", "/data/attention/query/filter/value"],
    ["a misspelt selected field", (a) => ((a as any).data.attention.query.select = ["tailNumbr"]), "unknown-field", "/data/attention/query/select/0"],
    ["a reference to nothing", (a) => (flowSteps(a)[0].read.id = "$input.aircraft"), "unknown-field", "/flows/ground/steps/0/read/id"],
    ["a forward reference", (a) => (flowSteps(a)[0].read.id = "$triage.eventId"), "forward-reference", "/flows/ground/steps/0/read/id"],
    ["a parallel read that depends on its sibling", (a) => (flowSteps(a)[1].steps[1].read.query.filter.value = "$history.$id"), "unsupported", "/flows/ground/steps/1/steps/1/read/query/filter/value"],
    ["a path through a list", (a) => (flowSteps(a)[4].input.history = "$history.description"), "list-path", "/flows/ground/steps/4/input/history"],
    ["an enum compared with a value it never has", (a) => (flowSteps(a)[3].assert = { ne: ["$aircraft.maintenanceStatus", "grounded"] }), "not-in-enum", "/flows/ground/steps/3/assert/ne"],
    ["a string ordered like a number", (a) => (flowSteps(a)[3].assert = { gt: ["$aircraft.tailNumber", 3] }), "not-comparable", "/flows/ground/steps/3/assert/gt"],
    ["a check that is not a boolean", (a) => (flowSteps(a)[3].assert = "$aircraft.tailNumber"), "type-mismatch", "/flows/ground/steps/3/assert"],
    ["an Action input it does not take", (a) => (flowSteps(a)[6].input.assignee = "x"), "unknown-input", "/flows/ground/steps/6/input/assignee"],
    ["an Action input missing", (a) => delete flowSteps(a)[6].input.assignedTo, "missing-input", "/flows/ground/steps/6/input"],
    ["an Action input outside its enum", (a) => (flowSteps(a)[6].compensate.input.status = "done"), "not-in-enum", "/flows/ground/steps/6/compensate/input/status"],
    ["an AI proposal acted on without an approval", (a) => flowSteps(a).splice(5, 1), "unreviewed-ai-output", "/flows/ground/steps/5"],
    ["an AI step sent an Action's output", (a) => flowSteps(a).push({ kind: "ai", name: "late", model: "triage", prompt: "x", input: { o: "$open.id" }, output: { type: "object" } }), "unsupported", "/flows/ground/steps/7/input/o"],
    ["an unknown model role", (a) => (flowSteps(a)[4].model = "triager"), "unknown-model", "/flows/ground/steps/4/model"],
    ["a retried Action that is not idempotent", (a) => (flowSteps(a)[6].retry = { maxAttempts: 3 }), "retry-not-idempotent", "/flows/ground/steps/6"],
    ["an approval presenting a later step", (a) => (flowSteps(a)[5].present = ["open"]), "forward-reference", "/flows/ground/steps/5/present/0"],
    [
      "a required input from a step that may be skipped",
      (a) => {
        flowSteps(a)[4].when = { gt: ["$poorParts", 0] };
      },
      "maybe-skipped",
      "/flows/ground/steps/6/input/maintenanceEventId"
    ],
    ["the clock in a flow", (a) => (flowSteps(a)[2].value = { hoursSince: "$aircraft.lastMaintainedAt" }), "nondeterministic-in-flow", "/flows/ground/steps/2/value"],
    ["data that depend on themselves", (a) => ((a as any).data.attention.query.filter.value = { gt: [{ count: "$attention" }, 0] }), "cyclic-dependency", "/data/attention"],
    [
      "data in a cycle",
      (a) => {
        (a as any).pages[0].data = {
          one: { kind: "object", type: "airforce.Aircraft", id: "$two.$id" },
          two: { kind: "object", type: "airforce.Aircraft", id: "$one.$id" }
        };
        layout(a).children.push({ kind: "detail", data: "one", fields: ["tailNumber"] }, { kind: "detail", data: "two", fields: ["tailNumber"] });
      },
      "cyclic-dependency",
      "/pages/0/data/one"
    ],
    ["a table over an object", (a) => (layout(a).children[1].data = "selectedAircraft"), "list-expected", "/pages/0/layout/children/1/data"],
    ["a column that is not a field", (a) => (layout(a).children[1].columns[0] = "tail"), "unknown-field", "/pages/0/layout/children/1/columns/0"],
    ["a tone for a value the field never has", (a) => (layout(a).children[1].columns[2].tone.GROUNDED = "bad"), "not-in-enum", "/pages/0/layout/children/1/columns/2/tone/GROUNDED"],
    ["a tone that is not a tone", (a) => (layout(a).children[0].tone = { if: [true, "red", "good"] }), "not-in-enum", "/pages/0/layout/children/0/tone"],
    ["selection into state that does not exist", (a) => (layout(a).children[1].select = "picked"), "unknown-reference", "/pages/0/layout/children/1/select"],
    ["a run of a flow that does not exist", (a) => (layout(a).children[1].rowActions[0].do[0].run = "grounding"), "unknown-flow", "/pages/0/layout/children/1/rowActions/0/do/0/run"],
    ["a run without its input", (a) => (layout(a).children[1].rowActions[0].do[0].input = {}), "missing-input", "/pages/0/layout/children/1/rowActions/0/do/0/input"],
    [
      "an Action invoked without confirmation",
      (a) => (layout(a).children[1].rowActions[0].do = [{ invoke: "UpdateWorkOrderStatus", input: { workOrderId: "$row.$id", status: "closed" }, confirm: false }]),
      "unconfirmed-effect",
      "/pages/0/layout/children/1/rowActions/0/do/0/confirm"
    ],
    ["navigation to no page", (a) => (layout(a).children[1].onSelect = [{ navigate: "Aircraft", params: { id: "$row.$id" } }]), "unknown-page", "/pages/0/layout/children/1/onSelect/0/navigate"],
    ["a flow's step referred to from the interface", (a) => (layout(a).children[0].value = "$triage.priority"), "unknown-reference", "/pages/0/layout/children/0/value"],
    ["$row outside a row", (a) => (layout(a).children[0].value = "$row.tailNumber"), "unknown-reference", "/pages/0/layout/children/0/value"],
    [
      "an assistant over a flow that acts",
      (a) => layout(a).children.push({ kind: "assistant", flow: "ground", step: "triage", input: { aircraftId: "$state.selected" } }),
      "unsupported",
      "/pages/0/layout/children/4/flow"
    ],
    ["a screen check on a node that does not exist", (a) => ((a as any).acceptance[4].visible = ["board"]), "invalid-check", "/acceptance/4/visible/0"],
    ["a check on a flow that does not exist", (a) => ((a as any).acceptance[2].workflow = "airforce.Ground"), "unknown-flow", "/acceptance/2/workflow"],
    ["an approval check on a step that is not an approval", (a) => ((a as any).acceptance[3].step = "open"), "invalid-check", "/acceptance/3/step"],
    ["a custom component prop of the wrong type", (a) => layout(a).children.push({ kind: "custom", component: "budget#Budget", props: { count: "$attention" }, propTypes: { count: { type: "integer" } } }), "type-mismatch", "/pages/0/layout/children/4/props/count"],
    [
      "a function called with two contracts",
      (a) => {
        layout(a).children.push(
          { kind: "metric", label: "a", value: { fn: "risk#score", args: { n: 1 }, returns: { type: "number" } } },
          { kind: "metric", label: "b", value: { fn: "risk#score", args: { n: "x" }, returns: { type: "number" } } }
        );
      },
      "type-mismatch",
      "/pages/0/layout/children/5/value"
    ]
  ];

  it.each(cases)("reports %s at the place it is", async (_what, mutate, code, at) => {
    const app = squadronApp();
    mutate(app);
    const r = await checkApp(app, await airforceEnv());
    expect(r.ok).toBe(false);
    expect(r.diagnostics.filter((d) => d.severity === "error").map((d) => [d.code, d.at])).toContainEqual([code, at]);
  });

  it("says what was probably meant", async () => {
    const app = squadronApp();
    (app as any).data.attention.query.type = "airforce.Aircarft";
    flowSteps(app)[0].read.id = "$input.aircraftID";
    const r = await checkApp(app, await airforceEnv());
    expect(r.diagnostics.find((d) => d.code === "unknown-type")!.hint).toBe('did you mean "airforce.Aircraft"?');
    expect(r.diagnostics.find((d) => d.at === "/flows/ground/steps/0/read/id")!.hint).toBe('did you mean "aircraftId"?');
  });

  it("lists only data as what derived data depend on, never a scope an operator binds", async () => {
    const app = squadronApp() as unknown as { data: Record<string, unknown> };
    app.data.degraded = { kind: "derive", value: { where: ["$attention", { ne: ["$item.maintenanceStatus", "operational"] }] } };
    const r = await checkApp(app, await airforceEnv());
    expect(r.data.degraded!.deps.data).toEqual(["attention"]);
  });

  it("does not report a skipped value used by a step with the same condition", async () => {
    const app = squadronApp();
    const when = { gt: ["$poorParts", 0] };
    for (const i of [4, 5, 6]) flowSteps(app)[i].when = when;
    const r = await checkApp(app, await airforceEnv());
    expect(r.diagnostics.filter((d) => d.code === "maybe-skipped")).toEqual([]);
  });

  it("reports a value that may be skipped once it is needed, and a coalesce resolves it", async () => {
    const app = squadronApp();
    flowSteps(app)[4].when = { gt: ["$poorParts", 0] };
    flowSteps(app)[5].when = { gt: ["$poorParts", 0] };
    flowSteps(app)[6].input.maintenanceEventId = { coalesce: ["$triage.eventId", "none"] };
    const r = await checkApp(app, await airforceEnv());
    expect(r.diagnostics.filter((d) => d.code === "maybe-skipped")).toEqual([]);
  });

  it("asks the runtime who each policy admits, and warns when it admits no caller", async () => {
    const env = await airforceEnv({
      admits: async (policy, _resource, caller) => (policy === "airforce.maintainer-only" ? ["maintainer", "lead"].includes(caller) : policy === "airforce.maintenance-lead" ? caller === "lead" : false)
    });
    const r = await checkApp(squadronApp(), env);
    expect(r.flows.ground!.admitted).toEqual({ start: ["maintainer", "lead"], approvals: { leadApproval: ["lead"] } });
    const app = squadronApp();
    flowSteps(app)[5].policy = "airforce.nobody";
    const r2 = await checkApp(app, env);
    expect(r2.diagnostics.find((d) => d.code === "no-caller-admitted")).toMatchObject({ severity: "warning", at: "/flows/ground/steps/5/policy" });
  });

  it("refuses a development model, and warns when the model's audience is not told of what it is sent", async () => {
    const dev = await checkApp(squadronApp(), await airforceEnv({ models: { enclave: { uses: ["development"] } } }));
    expect(dev.diagnostics.map((d) => d.code)).toContain("model-not-runtime");
    const blind = await checkApp(
      squadronApp(),
      await airforceEnv({
        models: { enclave: { uses: ["runtime"], audience: { id: "model:x", kind: "model", roles: [], attributes: {} } } },
        describedToAudience: async () => ({ format: "typesys.model/1", types: [], actions: [] })
      })
    );
    const d = blind.diagnostics.find((x) => x.code === "model-audience-blind")!;
    expect(d).toMatchObject({ severity: "warning", at: "/flows/ground/steps/4" });
    expect(d.message).toContain("airforce.Aircraft");
  });

  it("reports every structural problem before any is looked up", () => {
    const problems = appProblems({ format: "typesys.app/1", name: "Bad Name", pages: [{ name: "x", path: "/a/:id", layout: { kind: "tablee" } }], acceptance: [], extra: 1 });
    const codes = problems.map((p) => `${p.code} ${p.at}`);
    expect(codes).toEqual(
      expect.arrayContaining(["invalid-app /extra", "invalid-name /name", "invalid-app /title", "invalid-app /host", "invalid-name /pages/0/name", "page-param /pages/0/params", "invalid-app /pages/0/layout/kind", "invalid-app /acceptance"])
    );
    expect(problems.find((p) => p.at === "/pages/0/layout/kind")!.hint).toBe('did you mean "table"?');
  });

  it("points a mission at its translation", () => {
    expect(appProblems({ format: "typesys.mission/1" }).find((p) => p.at === "/format")!.hint).toContain("typesys app migrate");
  });
});
