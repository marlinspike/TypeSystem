/**
 * Milestone D (roadmap 5): what the 5.0 workbench tools change for a
 * developer or coding agent, measured without calling any model.
 *
 *   npm run build && npx tsx scripts/measure-workbench.ts
 *
 * Three arms answer the same questions:
 *
 * - A, ordinary tools: the domain's source files, read as a developer
 *   reads them. Nothing is run.
 * - B, the runtime as 4.0 shipped it: describeModel, query, getObject,
 *   getRelationship, explainQuery, previewAction, diffModels and the 4.0
 *   context compiler, taken from commit 1f40e56 and run unchanged.
 * - C, the same runtime with the 5.0 tools: explain, inspectModel, the
 *   graph, the task-aware context, change impact and link probes.
 *
 * Ground truth comes from the definitions (the manifests, the application
 * spec and the workflow) or from plain reads before and after a change,
 * never from the code being measured. Each arm's answer is the output its
 * tools return, scored by whether it states the truth, and costed in
 * estimated tokens (four characters each) and calls. Writes
 * docs/evidence/semantic-workbench/results.json.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describeModel, requireRole, type DomainManifest, type Identity, type SemanticRuntime } from "@typesys/core";
import { analyzeChange, compileContext, diffModels, governedGraph, probeLinks, queryGraph, recordBaseline, type GraphConsumer, type Reach } from "@typesys/devkit";
import { airforceManifest, buildAirforceWorkbench, demoIdentities, groundForRepair, releaseReadinessToViewers } from "@typesys/domain-airforce";
import { buildHospitalTestbed, hospitalDemoIdentities } from "@typesys/domain-hospital";
import { buildColdChainHost, coldChainIdentities, startServices } from "@typesys/cold-chain";
import { workflowUses } from "@typesys/workflow";
import { appUses } from "../packages/compiler/src/uses.js";
import { squadronApp } from "../packages/compiler/test/fixtures.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "docs/evidence/semantic-workbench");
const CONTEXT_4_COMMIT = "1f40e56";
const tokens = (x: unknown) => Math.ceil((typeof x === "string" ? x : JSON.stringify(x)).length / 4);
const says = (x: unknown, ...needles: string[]) => {
  const s = typeof x === "string" ? x : JSON.stringify(x);
  return needles.every((n) => s.includes(n));
};

/** The 4.0 context compiler, exactly as commit 1f40e56 shipped it, beside the modules it imports (unchanged since). */
async function context4(): Promise<typeof compileContext> {
  const source = execFileSync("git", ["show", `${CONTEXT_4_COMMIT}:packages/devkit/src/context.ts`], { cwd: ROOT, encoding: "utf8" });
  const dir = path.join(ROOT, "node_modules/.cache/typesys-eval");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "context-4.ts");
  const src = path.join(ROOT, "packages/devkit/src");
  writeFileSync(file, source.replace(`"./catalog.js"`, JSON.stringify(path.join(src, "catalog.ts"))).replace(`"./discover.js"`, JSON.stringify(path.join(src, "discover.ts"))));
  return ((await import(file)) as { compileContext: typeof compileContext }).compileContext;
}

/** Arm A's cost for a question: every source file of the package that names one of these identifiers, read whole. */
function sourceRead(pkg: string, identifiers: readonly string[]): { files: string[]; tokens: number } {
  const dir = path.join(ROOT, "packages", pkg, "src");
  const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(path.join(d, f)).isDirectory() ? walk(path.join(d, f)) : f.endsWith(".ts") ? [path.join(d, f)] : []));
  const files = walk(dir).filter((f) => identifiers.some((id) => readFileSync(f, "utf8").includes(id)));
  return { files: files.map((f) => path.relative(ROOT, f)), tokens: files.reduce((n, f) => n + tokens(readFileSync(f, "utf8")), 0) };
}

interface ArmAnswer {
  /** States the truth, from the tools' output alone. */
  readonly answered: boolean | "partly";
  readonly calls: number;
  readonly tokens: number;
  readonly note: string;
  readonly parts?: readonly string[];
}
interface Question {
  readonly id: string;
  readonly question: string;
  readonly truth: string;
  readonly A: ArmAnswer & { readonly files: readonly string[] };
  readonly B: ArmAnswer;
  readonly C: ArmAnswer;
  /** Names the caller may not learn of that appear in what the caller's own tools returned them. */
  readonly leaks: { readonly B: readonly string[]; readonly C: readonly string[] };
}

const leaked = (x: unknown, forbidden: readonly string[]) => {
  const s = typeof x === "string" ? x : JSON.stringify(x);
  return forbidden.filter((f) => new RegExp(`(^|[^\\w-])${f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\w-])`).test(s));
};

/**
 * Names a caller may not learn of: policy names, markings and source ids
 * from the inspection, less any the caller's own description already tells
 * them (a description that says "Classified SECRET").
 */
async function forbiddenFor(runtime: SemanticRuntime, inspector: Identity, caller: Identity): Promise<string[]> {
  const i = await runtime.inspectModel(inspector);
  const told = await runtime.describeModel(caller);
  return [...new Set([...i.policies.map((p) => p.name), ...i.types.flatMap((t) => [t.source?.dataSourceId ?? "", ...t.members.flatMap((m) => m.markings)]).filter(Boolean)])].filter((name) => leaked(told, [name]).length === 0);
}

async function questions(): Promise<Question[]> {
  const out: Question[] = [];
  const air = await buildAirforceWorkbench({ mockRestLatencyMs: 0 });
  const viewer = demoIdentities.viewer;
  const lead = demoIdentities.lead;
  // The object policy names itself in a refusal the viewer is already given, so it is not counted as a leak.
  const forbidden = (await forbiddenFor(air.runtime, lead, viewer)).filter((f) => f !== "airforce.read-aircraft");

  // B, the caller's own: the description, a read and the query plan.
  const bDescribe = await air.runtime.describeModel(viewer);
  const bRead = await air.runtime.getObject("airforce.Aircraft", "AF86-0147", viewer);
  const bPlan = await air.runtime.explainQuery({ type: "airforce.Aircraft", limit: 1 }, viewer);
  const bAll = [bDescribe.types.find((t) => t.name === "airforce.Aircraft"), bRead, bPlan];
  // C, the caller's own explanation, and the lead's explanation of the viewer.
  const cSelf = await air.runtime.explain({ kind: "read", type: "airforce.Aircraft", id: "AF86-0147" }, viewer);
  const cAs = await air.runtime.explain({ kind: "read", type: "airforce.Aircraft", id: "AF86-0147" }, lead, { as: viewer });
  const finding = (e: typeof cSelf, m: string) => e.findings.find((f) => f.member === m);
  const aircraftSource = (ids: string[]) => sourceRead("domain-airforce", ids);

  const policy = airforceManifest.types.find((t) => t.options.name === "airforce.Aircraft")!.schema["x-policy"]!.propertyPolicies!.maintenanceStatus!;
  const a1 = aircraftSource(["maintainer-only"]);
  out.push({
    id: "Q1",
    question: "Why does the viewer not get maintenanceStatus on AF86-0147?",
    truth: `member policy ${policy}`,
    A: { answered: true, calls: 0, ...a1, note: "The policy is named in the Type and defined in setup.ts; the viewer's roles are in setup.ts." },
    B: { answered: says(bPlan, "memberPolicies", "maintenanceStatus") ? "partly" : false, calls: 3, tokens: tokens(bAll), note: "The query plan lists maintenanceStatus under the member policies it redacts, without naming the policy." },
    C: { answered: finding(cAs, "maintenanceStatus")?.policy === policy, calls: 1, tokens: tokens(cAs), note: `The lead's explanation as the viewer names ${policy}, its rule and the remedy. The viewer's own says member-policy.` },
    leaks: { B: leaked(bAll, forbidden), C: leaked(cSelf, forbidden) }
  });
  const a2 = aircraftSource(["readinessStatus"]);
  out.push({
    id: "Q2",
    question: "Why does the viewer not get readinessStatus?",
    truth: "it is computed from maintenanceStatus, which the viewer may not read, and not released",
    A: { answered: true, calls: 0, ...a2, note: "dependsOn and releases are in the Type; the rule that a computed value follows its inputs is in the runtime's documentation." },
    B: { answered: "partly", calls: 3, tokens: tokens(bAll), note: "The plan shows readinessStatus computed from maintenanceStatus and maintenanceStatus redacted; the agent must infer the rule." },
    C: { answered: finding(cSelf, "readinessStatus")?.control === "derivation" && says(finding(cAs, "readinessStatus"), "maintenanceStatus", "releases"), calls: 1, tokens: tokens(cSelf), note: "control derivation, with its input and how to release it." },
    leaks: { B: [], C: [] }
  });
  const a3 = aircraftSource(["SECRET"]);
  out.push({
    id: "Q3",
    question: "Why does the viewer not get deploymentLocation?",
    truth: "it is marked SECRET and the viewer is cleared CUI",
    A: { answered: true, calls: 0, ...a3, note: "The marking is in the Type; clearances are in setup.ts." },
    B: { answered: says(bPlan, "marked", "deploymentLocation") ? "partly" : false, calls: 3, tokens: tokens(bAll), note: "The plan lists deploymentLocation as marked, without the marking; its description says SECRET." },
    C: { answered: finding(cSelf, "deploymentLocation")?.control === "classification" && says(finding(cAs, "deploymentLocation"), "SECRET"), calls: 1, tokens: tokens(cAs), note: "control classification; the lead is told the marking and the remedy." },
    leaks: { B: [], C: [] }
  });

  // An Action the viewer may not invoke.
  const input = { aircraftId: "AF86-0147", description: "Inspect", priority: "low" };
  let bPreview: unknown;
  try {
    bPreview = await air.runtime.previewAction("CreateMaintenanceWorkOrder", input, viewer);
  } catch (err) {
    bPreview = { error: (err as Error).message };
  }
  const bActions = await air.runtime.listActions("airforce.Aircraft", viewer);
  const cInvoke = await air.runtime.explain({ kind: "invoke", action: "CreateMaintenanceWorkOrder", input }, lead, { as: viewer });
  const a4 = aircraftSource(["CreateMaintenanceWorkOrder"]);
  const actionPolicy = (await air.runtime.inspectModel(lead)).actions.find((a) => a.name === "CreateMaintenanceWorkOrder")?.policy ?? "";
  out.push({
    id: "Q4",
    question: "Why is the viewer refused CreateMaintenanceWorkOrder?",
    truth: `Action policy ${actionPolicy}`,
    A: { answered: true, calls: 0, ...a4, note: "The Action names its policy; the rule is in setup.ts." },
    B: { answered: says([bPreview, bActions], actionPolicy) ? true : says([bPreview, bActions], "role") ? "partly" : false, calls: 2, tokens: tokens([bPreview, bActions]), note: "listActions says it is not invocable; the preview's refusal gives the engine's reason." },
    C: { answered: says(cInvoke, actionPolicy), calls: 1, tokens: tokens(cInvoke), note: "The explanation names the policy, its rule and the remedy, and the effects it would have." },
    leaks: { B: leaked([bPreview, bActions], forbidden.filter((f) => f !== actionPolicy)), C: [] }
  });

  // What is built on maintenanceStatus. Truth: the application parts and workflow steps that name it or a value computed from it.
  const model = await describeModel(air.registry);
  const consumers: GraphConsumer[] = [...appUses(squadronApp(), model), workflowUses(groundForRepair)];
  const derived = ["maintenanceStatus", "readinessStatus", "needsAttention"];
  const spec = squadronApp();
  // Parts whose own declaration names one of the values: what a reader finds by searching the spec.
  const truthParts = new Set<string>([
    ...Object.entries(spec.data ?? {}).filter(([, d]) => derived.some((v) => says(d, v))).map(([n]) => `data.${n}`),
    // A flow compiles to a workflow of its own name, which the graph holds as that workflow.
    ...Object.values(spec.flows ?? {}).filter((d) => derived.some((v) => says(d, v))).map((d) => `workflow:${d.name}`),
    ...spec.pages.filter((pg) => derived.some((v) => says(pg, v))).map((pg) => `page.${pg.name}`),
    ...spec.acceptance.filter((c) => derived.some((v) => says(c, v))).map((c) => `check.${c.id}`)
  ]);
  if (derived.some((v) => says(readFileSync(path.join(ROOT, "packages/domain-airforce/src/workflows/ground-for-repair.ts"), "utf8"), v))) truthParts.add("workflow:airforce.GroundForRepair");
  const graph = await governedGraph(air.runtime, lead, consumers);
  const reach = queryGraph(graph, { view: "dependents", node: "member:airforce.Aircraft.maintenanceStatus" }) as unknown as Reach;
  const reached = new Set(reach.reached.map((r) => r.id));
  const cParts = [...new Set([...reached].flatMap((n) => (n.startsWith("part:app:") ? [n.split("/").pop()!] : n.startsWith("part:workflow:") ? [n.slice(5, n.indexOf("/"))] : [])))];
  const recall = [...truthParts].filter((p) => cParts.includes(p)).length;
  // Arm A reads the spec (as its JSON, not the fixtures file that holds it among others) and the workflow.
  const a5 = { files: ["the squadron application spec", "packages/domain-airforce/src/workflows/ground-for-repair.ts"], tokens: tokens(JSON.stringify(spec, null, 2)) + tokens(readFileSync(path.join(ROOT, "packages/domain-airforce/src/workflows/ground-for-repair.ts"), "utf8")) };
  out.push({
    id: "Q5",
    question: "What in the squadron application and GroundForRepair is built on maintenanceStatus, directly or through a value computed from it?",
    truth: `${truthParts.size} parts and workflows: ${[...truthParts].sort().join(", ")}`,
    A: { answered: true, calls: 0, ...a5, note: "Read the application spec and the workflow, and follow each part's references by hand." },
    B: { answered: false, calls: 0, tokens: 0, note: "No 4.0 tool relates a value to what uses it. diffApps compares two specs; it does not say what a spec rests on." },
    C: { answered: recall === truthParts.size ? true : recall > 0 ? "partly" : false, calls: 1, tokens: tokens(reach), note: `One dependents query on maintenanceStatus names ${recall} of the ${truthParts.size}, and ${cParts.length - recall} more that use them through another part.`, parts: cParts.sort() },
    leaks: { B: [], C: [] }
  });

  // Cold Chain: where a shipment's destination Site comes from, across systems.
  const services = await startServices();
  try {
    const host = await buildColdChainHost({ urls: { tracker: services.tracker.url, sensors: services.sensors.url, inventory: services.inventory.url } });
    const qa = coldChainIdentities.qa;
    const [site] = await host.runtime.getRelationship("coldchain.Shipment", "SH-1046", "destinationSite", qa);
    const bSite = await host.runtime.getObject("coldchain.Site", site!.objectId, qa, { includeProvenance: true });
    const bShip = await host.runtime.describeModel(qa);
    const links = await probeLinks(host.runtime, qa, { types: ["coldchain.Shipment"], crossSourceOnly: true });
    const destination = links.relationships.find((r) => r.relationship === "destinationSite");
    const a6 = sourceRead("cold-chain", ["destinationSite", "byOwnField"]);
    out.push({
      id: "Q6",
      question: "Which system does a shipment's destination Site come from, and does the link resolve?",
      truth: "the pharmacy inventory, by the facility code the tracker holds",
      A: { answered: true, calls: 0, ...a6, note: "The relationship, its resolution and the Site's mapping are in model.ts and adapters.ts." },
      B: { answered: says(bSite, "pharmacy-inventory"), calls: 3, tokens: tokens([bShip.types.find((t) => t.name === "coldchain.Shipment"), site, bSite]), note: "The description names no source. Following the link and reading the Site with provenance names it, one object at a time." },
      C: { answered: destination?.crossSource?.target === "pharmacy-inventory" && destination.returned === destination.probed, calls: 1, tokens: tokens(links), note: "One probe lists every cross-system link of Shipment, the systems each crosses and how it resolved on three shipments." },
      leaks: { B: [], C: [] }
    });
  } finally {
    await services.stop();
  }

  // Hospital: an appointment for a patient no source holds.
  const tb = await buildHospitalTestbed({ runtimeOptions: { inspection: { policy: "hospital.inspect" } } });
  (tb.policyEngine as unknown as { registerRule(n: string, r: unknown): void }).registerRule("hospital.inspect", requireRole("admin"));
  tb.adapter.seed("hospital.Appointment", [{ objectId: "APT-0404", values: { id: "APT-0404", patientId: "PT-0404", providerId: "PR-2001", scheduledAt: "2026-10-20T09:00:00.000Z", status: "scheduled" } }]);
  const admin = { subjectId: "user-admin-1", roles: ["admin"], attributes: {} };
  const bPatient = await tb.runtime.getRelationship("hospital.Appointment", "APT-0404", "patient", admin);
  const cDangling = await tb.runtime.explain({ kind: "relationship", type: "hospital.Appointment", id: "APT-0404", relationship: "patient" }, admin, { as: hospitalDemoIdentities.clinician });
  const cSelfDangling = await tb.runtime.explain({ kind: "relationship", type: "hospital.Appointment", id: "APT-0404", relationship: "patient" }, hospitalDemoIdentities.clinician);
  out.push({
    id: "Q7",
    question: "Appointment APT-0404 shows no patient. Is the patient missing, refused, or never linked?",
    truth: "the appointment names PT-0404, which no source holds (a dangling reference)",
    A: { answered: false, calls: 0, files: [], tokens: 0, note: "The definitions cannot say; it is a fact about the data. A developer queries the record system by hand." },
    B: { answered: false, calls: 1, tokens: tokens(bPatient), note: "getRelationship returns an empty list, the same as no patient or a refused one (ADR-0048)." },
    C: { answered: cDangling.findings.some((f) => f.outcome === "dangling" && f.about.includes("PT-0404")), calls: 1, tokens: tokens(cDangling), note: "Explained by the administrator as the clinician: dangling, naming PT-0404. The clinician's own explanation does not name it." },
    leaks: { B: [], C: leaked(cSelfDangling, ["PT-0404"]) }
  });
  return out;
}

interface Requirement {
  readonly id: string;
  readonly task: string;
  readonly as: keyof typeof demoIdentities;
  /** What a correct implementation needs, authored from the definitions before either compiler was run on it. */
  readonly needsTypes: readonly string[];
  readonly needsActions: readonly string[];
}

/**
 * Requirements no test, fixture or document in the repository uses. The
 * fourth avoids the model's words on purpose: a keyword ranker has
 * nothing to match.
 */
const REQUIREMENTS: readonly Requirement[] = [
  { id: "R1", task: "Show the viewer a list of aircraft that need attention, with each one's installed components", as: "viewer", needsTypes: ["airforce.Aircraft", "airforce.Component"], needsActions: [] },
  { id: "R2", task: "Let a maintainer open a work order for an aircraft from its maintenance history page", as: "maintainer", needsTypes: ["airforce.Aircraft", "airforce.MaintenanceEvent", "airforce.WorkOrder"], needsActions: ["CreateMaintenanceWorkOrder"] },
  { id: "R3", task: "A report of components in poor condition, grouped by aircraft, for the viewer", as: "viewer", needsTypes: ["airforce.Component", "airforce.Aircraft"], needsActions: [] },
  { id: "R4", task: "Flag jets that are overdue for upkeep so a crew chief can schedule them", as: "maintainer", needsTypes: ["airforce.Aircraft", "airforce.MaintenanceEvent"], needsActions: ["CreateMaintenanceWorkOrder"] }
];

async function contexts() {
  const air = await buildAirforceWorkbench({ mockRestLatencyMs: 0 });
  const old = await context4();
  const consumers: GraphConsumer[] = [...appUses(squadronApp(), await describeModel(air.registry)), workflowUses(groundForRepair)];
  const forbidden = (await forbiddenFor(air.runtime, demoIdentities.lead, demoIdentities.viewer)).filter((f) => f !== "airforce.read-aircraft");
  // Values each caller is not returned, from the definitions: the viewer is not a maintainer and is cleared CUI.
  const withheldFor = { viewer: ["maintenanceStatus", "readinessStatus", "deploymentLocation"], maintainer: [] as string[] };
  const rows = [];
  for (const r of REQUIREMENTS) {
    const who = demoIdentities[r.as];
    const arms = { B: await old(air.runtime, who, { task: r.task }), C: await compileContext(air.runtime, who, { task: r.task, consumers }) };
    const score = (c: (typeof arms)["B"]) => {
      const types = c.types.map((t) => t.name);
      const actions = c.actions.map((a) => a.name);
      const aircraft = c.types.find((t) => t.name === "airforce.Aircraft") as ((typeof c.types)[number] & { access?: { member: string; status: string; note: string }[] }) | undefined;
      const withheld = r.as === "viewer" ? withheldFor.viewer : withheldFor.maintainer;
      return {
        tokens: c.tokens,
        typesNeeded: r.needsTypes.filter((t) => types.includes(t)).length,
        actionsNeeded: r.needsActions.filter((a) => actions.includes(a)).length,
        extraTypes: types.filter((t) => !r.needsTypes.includes(t)).length,
        // Each value the caller is not returned: is it marked as such, and with the control that withholds it?
        withheldMarked: withheld.filter((m) => aircraft?.access?.some((a) => a.member === m && a.status === "withheld") || aircraft?.visibility?.neverReturned.includes(m)).length,
        withheldExplained: withheld.filter((m) => aircraft?.access?.some((a) => a.member === m && a.status === "withheld" && a.note.length > 0)).length,
        withheld: withheld.length,
        checks: "checks" in c ? (c as { checks: readonly unknown[] }).checks.length : 0,
        leaks: leaked(c.text, forbidden)
      };
    };
    rows.push({ id: r.id, task: r.task, as: r.as, needs: { types: r.needsTypes, actions: r.needsActions }, B: score(arms.B), C: score(arms.C), selected: { B: arms.B.types.map((t) => t.name), C: arms.C.types.map((t) => t.name) } });
  }
  return rows;
}

interface Change {
  readonly id: string;
  readonly change: string;
  readonly manifest: DomainManifest;
}
const aircraftEntry = (m: DomainManifest, fn: (schema: Record<string, unknown>) => Record<string, unknown>, version = "1.1.0"): DomainManifest => ({
  ...m,
  types: m.types.map((t) => (t.options.name === "airforce.Aircraft" ? { ...t, schema: fn(structuredClone(t.schema) as Record<string, unknown>) as typeof t.schema, options: { ...t.options, version } } : t))
});

const CHANGES: readonly Change[] = [
  { id: "X1", change: "release readinessStatus to every reader, as needsAttention is", manifest: releaseReadinessToViewers() },
  {
    id: "X2",
    change: "take the member policy off maintenanceStatus",
    manifest: aircraftEntry(airforceManifest, (s) => ({ ...s, "x-policy": { objectPolicy: "airforce.read-aircraft" } }))
  },
  {
    id: "X3",
    change: "guard tailNumber with airforce.maintainer-only",
    manifest: aircraftEntry(airforceManifest, (s) => ({ ...s, "x-policy": { objectPolicy: "airforce.read-aircraft", propertyPolicies: { maintenanceStatus: "airforce.maintainer-only", tailNumber: "airforce.maintainer-only" } } }))
  },
  { id: "X4", change: "drop the SECRET marking from deploymentLocation", manifest: aircraftEntry(airforceManifest, (s) => ({ ...s, "x-provenance": { properties: {} } })) },
  {
    id: "X5",
    change: "remove the model value",
    manifest: aircraftEntry(airforceManifest, (s) => {
      const p = { ...(s.properties as Record<string, unknown>) };
      delete p.model;
      return { ...s, properties: p, required: ["tailNumber"] };
    })
  },
  { id: "X6", change: "a patch version bump and nothing else (control)", manifest: aircraftEntry(airforceManifest, (s) => s, "1.0.1") }
];

/** What each caller is returned on AF86-0147: the ground truth an exposure is checked against, read plainly. */
async function returned(runtime: SemanticRuntime): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const who of ["viewer", "maintainer"] as const) out[who] = Object.keys((await runtime.getObject("airforce.Aircraft", "AF86-0147", demoIdentities[who])).values).sort();
  return out;
}

async function changes() {
  const callers = { maintainer: demoIdentities.maintainer, viewer: demoIdentities.viewer };
  const current = await buildAirforceWorkbench({ mockRestLatencyMs: 0 });
  const consumers: GraphConsumer[] = [...appUses(squadronApp(), await describeModel(current.registry)), workflowUses(groundForRepair)];
  let started = performance.now();
  const before = await recordBaseline(current.runtime, demoIdentities.lead, { callers });
  const recordMs = performance.now() - started;
  const beforeReads = await returned(current.runtime);
  const rows = [];
  for (const c of CHANGES) {
    const proposal = await buildAirforceWorkbench({ mockRestLatencyMs: 0, manifest: c.manifest });
    const afterReads = await returned(proposal.runtime);
    const truth = {
      viewerGains: afterReads.viewer!.filter((m) => !beforeReads.viewer!.includes(m)),
      viewerLoses: beforeReads.viewer!.filter((m) => !afterReads.viewer!.includes(m))
    };
    const after = await recordBaseline(proposal.runtime, demoIdentities.lead, { callers });
    const b = diffModels(before.description, after.description);
    started = performance.now();
    const i = analyzeChange(before, after, consumers);
    const analyzeMs = performance.now() - started;
    const exposed = i.exposures.filter((e) => e.as === "viewer").map((e) => e.subject.split(".").pop()!);
    const narrowed = i.items.filter((x) => x.kind === "observed" && x.as === "viewer" && x.effect === "narrows").map((x) => x.subject.split(".").pop()!);
    const changed = truth.viewerGains.length + truth.viewerLoses.length > 0;
    rows.push({
      id: c.id,
      change: c.change,
      truth,
      B: { verdict: b.changes.reduce<string>((w, x) => (x.impact === "breaking" || (x.impact === "risky" && w === "compatible") ? x.impact : w), "compatible"), changes: b.changes.length, tokens: tokens(b), seesAccessChange: false, consumersNamed: 0 },
      C: {
        verdict: i.verdict,
        items: i.items.length,
        tokens: tokens(i),
        exposuresRight: truth.viewerGains.every((m) => exposed.includes(m)) && exposed.every((m) => truth.viewerGains.includes(m)),
        narrowingsRight: truth.viewerLoses.every((m) => narrowed.includes(m)),
        seesAccessChange: changed ? exposed.length + narrowed.length > 0 : i.items.length === 0,
        consumersNamed: new Set(i.items.flatMap((x) => x.reaches.consumers)).size,
        checks: i.checks.length,
        analyzeMs: Math.round(analyzeMs)
      }
    });
  }
  return { recordMs: Math.round(recordMs), baselineTokens: tokens(before), rows };
}

const results = {
  generated: new Date().toISOString(),
  commit: execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(),
  context4Commit: CONTEXT_4_COMMIT,
  node: process.version,
  questions: await questions(),
  contexts: await contexts(),
  changes: await changes()
};
mkdirSync(OUT, { recursive: true });
writeFileSync(path.join(OUT, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
console.log(JSON.stringify(results, null, 1));
