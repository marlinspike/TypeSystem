/**
 * Measures the 4.0 application compiler against the 3.0 engineering loop
 * (`typesys engineer`) on the same mission, and the compiler alone on the
 * Cold Chain reference application. Everything here runs locally and costs
 * nothing: no model is called. Writes docs/evidence/compiler-productivity/results.json.
 *
 *   npx tsx scripts/measure-compiler.ts
 */
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp, compileApp, missionToApp, verifyApp, type AppSpec } from "@typesys/compiler";
import { engineerCommand, verifyMission, type MissionSpec } from "@typesys/engineer";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORK = path.join(ROOT, "packages/compiler/.work/measure");
const SORTIE = path.join(ROOT, "examples/missions/sortie-readiness/mission.json");
const COLD = path.join(ROOT, "examples/apps/cold-chain");
const OUT = path.join(ROOT, "docs/evidence/compiler-productivity/results.json");

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
const clone = <T>(v: T): T => structuredClone(v);
const time = async <T>(f: () => Promise<T>): Promise<[T, number]> => {
  const t = performance.now();
  const r = await f();
  return [r, Math.round(performance.now() - t)];
};

/** Scalar values in a JSON document: the decisions its author wrote, independent of formatting. */
function leaves(v: Json): number {
  if (v === null || typeof v !== "object") return 1;
  let n = 0;
  for (const x of Array.isArray(v) ? v : Object.values(v)) n += leaves(x);
  return n;
}

async function files(dir: string, under: (rel: string) => boolean): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const rel = path.relative(dir, p).split(path.sep).join("/");
      if (e.isDirectory()) {
        if (!["node_modules", "dist"].includes(e.name)) await walk(p);
      } else if (under(rel)) out.push(rel);
    }
  };
  await walk(dir);
  return out.sort();
}

async function size(dir: string, rels: readonly string[]) {
  let lines = 0;
  let chars = 0;
  for (const r of rels) {
    const text = await readFile(path.join(dir, r), "utf8");
    lines += text.split("\n").filter((l) => l.trim() !== "").length;
    chars += text.replace(/\s/g, "").length;
  }
  return { files: rels.length, lines, nonWhitespaceChars: chars };
}

const fresh = async (name: string) => {
  const d = path.join(WORK, name);
  await rm(d, { recursive: true, force: true });
  await mkdir(d, { recursive: true });
  return d;
};

const engineer = async (argv: string[]) => {
  let printed = "";
  const code = await engineerCommand([...argv, "--json"], (s) => (printed = s));
  return { code, out: JSON.parse(printed || "{}") as Record<string, unknown> };
};

// ---------------------------------------------------------------------------
// The two pipelines on one mission
// ---------------------------------------------------------------------------

async function missionArm(name: string, mission: MissionSpec) {
  const dir = await fresh(name);
  await writeFile(path.join(dir, "mission.json"), JSON.stringify(mission));
  const [scaffold, scaffoldMs] = await time(() => engineer(["scaffold", path.join(dir, "mission.json"), "--out", dir]));
  if (scaffold.code !== 0) return { dir, stage: "plan" as const, scaffoldMs, verifyMs: 0, report: undefined, scaffold: scaffold.out };
  const [report, verifyMs] = await time(() => verifyMission(dir));
  const stage = report.ok ? ("none" as const) : !report.stages.plan ? ("plan" as const) : !report.stages.build ? ("build" as const) : ("checks" as const);
  return { dir, stage, scaffoldMs, verifyMs, report, scaffold: scaffold.out };
}

async function appArm(name: string, spec: AppSpec) {
  const dir = await fresh(name);
  await writeFile(path.join(dir, "app.json"), JSON.stringify(spec));
  const [report, verifyMs] = await time(() => verifyApp(dir));
  const stage = report.ok ? ("none" as const) : !report.stages.check ? ("check" as const) : !report.stages.build ? ("build" as const) : ("acceptance" as const);
  return { dir, stage, verifyMs, report };
}

/**
 * Defects an author (a person or a model) plausibly writes, seeded once in
 * each spec at the equivalent place. What is measured: the stage that first
 * reports it, and whether the report points at the place in the spec.
 */
// A seed edits a cloned spec at a path it names; typing each path would add nothing the run does not check.
/* eslint-disable @typescript-eslint/no-explicit-any */
interface Seed {
  readonly id: string;
  readonly what: string;
  readonly mission: (m: Record<string, any>) => void;
  readonly app: (a: Record<string, any>) => void;
}
const ws = (m: Record<string, any>) => m.workflow.steps as Record<string, any>[];
const fs = (a: Record<string, any>) => a.flows.confirmSortie.steps as Record<string, any>[];
const SEEDS: readonly Seed[] = [
  { id: "type-typo", what: "a read names a Type that does not exist (ops.Aircraf)", mission: (m) => (ws(m)[0]!.type = "ops.Aircraf"), app: (a) => (fs(a)[0]!.read.type = "ops.Aircraf") },
  { id: "field-typo-in-check", what: "a check compares a field that does not exist ($pilot.assignedTial)", mission: (m) => (ws(m)[2]!.equal[0] = "$pilot.assignedTial"), app: (a) => (fs(a)[2]!.assert.eq[0] = "$pilot.assignedTial") },
  { id: "type-mismatch", what: "a check compares a string field with a number", mission: (m) => (ws(m)[2]!.equal[1] = 147), app: (a) => (fs(a)[2]!.assert.eq[1] = 147) },
  { id: "withheld-in-check", what: "a check compares a value the initiator is never returned ($pilot.name, withheld from maintainers)", mission: (m) => (ws(m)[2]!.equal = ["$pilot.name", "$aircraft.tailNumber"]), app: (a) => (fs(a)[2]!.assert.eq = ["$pilot.name", "$aircraft.tailNumber"]) },
  { id: "approval-policy-typo", what: "the approval names a policy that does not exist", mission: (m) => (ws(m)[3]!.policy = "ops.sortie-sign-off"), app: (a) => (fs(a)[3]!.policy = "ops.sortie-sign-off") },
  { id: "start-policy-typo", what: "the workflow's start policy does not exist", mission: (m) => (m.workflow.startPolicy = "ops.crw"), app: (a) => (a.flows.confirmSortie.startPolicy = "ops.crw") },
  {
    id: "view-field-typo",
    what: "a table shows a field that does not exist (missionCapabilty)",
    mission: (m) => (m.views[0].fields[3] = "missionCapabilty"),
    app: (a) => {
      a.pages[0].data.fleetBoard.query.select[3] = "missionCapabilty";
      a.pages[0].layout.children[0].columns[3] = "missionCapabilty";
    }
  },
  { id: "present-typo", what: "the approval presents a step that does not exist", mission: (m) => (ws(m)[3]!.present = ["aircraft", "pilots"]), app: (a) => (fs(a)[3]!.present = ["aircraft", "pilots"]) },
  {
    id: "approval-admits-requester",
    what: "the approval admits the requester (allowSelfApproval), which the requirement forbids for maintainers asking planners",
    mission: (m) => (ws(m)[3]!.policy = "ops.crew"),
    app: (a) => (fs(a)[3]!.policy = "ops.crew")
  },
  { id: "check-names-wrong-step", what: "an acceptance check waits on a step name that does not exist", mission: (m) => (m.acceptance[10].waitingOn = "plannerSignOff"), app: (a) => (a.acceptance[10].waitingOn = "plannerSignOff") }
];

const located = (d: { at?: string } | undefined, pointer: RegExp) => (d?.at ? pointer.test(d.at) : false);

async function main() {
  await rm(WORK, { recursive: true, force: true });
  await mkdir(WORK, { recursive: true });
  const mission = JSON.parse(await readFile(SORTIE, "utf8")) as MissionSpec;
  const app = missionToApp(mission).spec!;

  // Baselines: both pipelines, the unchanged spec.
  const m0 = await missionArm("mission-baseline", mission);
  const a0 = await appArm("app-baseline", app);
  const missionGenerated = (await files(m0.dir, (r) => r !== "mission.json")).filter((r) => /\.(ts|tsx|html|json)$/.test(r));
  const appGenerated = Object.keys(JSON.parse(await readFile(path.join(a0.dir, "typesys.lock.json"), "utf8")).files as object);
  const appHandwritten = await files(a0.dir, (r) => r.startsWith("src/extensions/"));

  // Compile-only and build timings, three runs each.
  const compileRuns: number[] = [];
  const buildRuns: number[] = [];
  for (let i = 0; i < 3; i++) {
    const d = await fresh(`app-timing-${i}`);
    await writeFile(path.join(d, "app.json"), JSON.stringify(app));
    compileRuns.push((await time(() => compileApp(d)))[1]);
    buildRuns.push((await time(() => buildApp(d)))[1]);
  }

  // Regeneration: the same one-word change to a table's title, and a hand edit to generated code beforehand.
  const regen = {
    mission: await (async () => {
      const d = m0.dir;
      const views = path.join(d, "views.tsx");
      const before = await readFile(views, "utf8");
      await writeFile(views, `${before}\n// a hand edit\n`);
      const changed = clone(mission) as Record<string, any>;
      changed.views[0].title = "Fleet board";
      await writeFile(path.join(d, "mission.json"), JSON.stringify(changed));
      const snapshot = new Map<string, string>();
      for (const r of missionGenerated) snapshot.set(r, await readFile(path.join(d, r), "utf8"));
      await engineer(["scaffold", path.join(d, "mission.json"), "--out", d]);
      const rewritten: string[] = [];
      for (const r of missionGenerated) if ((await readFile(path.join(d, r), "utf8")) !== snapshot.get(r)) rewritten.push(r);
      const editKept = (await readFile(views, "utf8")).includes("// a hand edit");
      return { filesChanged: rewritten, handEditToGeneratedFile: editKept ? "kept" : "overwritten without notice" };
    })(),
    app: await (async () => {
      const d = a0.dir;
      const page = path.join(d, "src/generated/pages/FleetBoard.tsx");
      const before = await readFile(page, "utf8");
      const changed = clone(app) as Record<string, any>;
      changed.pages[0].layout.children[0].title = "Fleet board";
      await writeFile(path.join(d, "app.json"), JSON.stringify(changed));
      const clean = await compileApp(d);
      await writeFile(page, `${await readFile(page, "utf8")}\n// a hand edit\n`);
      changed.pages[0].layout.children[0].title = "Fleet";
      await writeFile(path.join(d, "app.json"), JSON.stringify(changed));
      const edited = await compileApp(d);
      await writeFile(page, before);
      return {
        filesChanged: clean.written,
        handEditToGeneratedFile: edited.ok ? "overwritten" : `refused: ${edited.diagnostics.map((x) => `${x.code} at ${x.at}`).join("; ")}`
      };
    })()
  };

  // Seeded defects.
  const seeds = [];
  for (const s of SEEDS) {
    const m = clone(mission) as Record<string, any>;
    s.mission(m);
    const a = clone(app) as Record<string, any>;
    s.app(a);
    const mr = await missionArm(`seed-mission-${s.id}`, m as MissionSpec);
    const ar = await appArm(`seed-app-${s.id}`, a as AppSpec);
    type Diag = { code: string; at: string; severity: string; message: string };
    // A mission the engineer refuses outright reports at the top level; one it plans reports in the plan.
    const planned = [...((mr.scaffold.diagnostics as Diag[] | undefined) ?? []), ...((mr.scaffold.plan as { diagnostics?: Diag[] } | undefined)?.diagnostics ?? [])].filter((d) => d.severity === "error");
    const mFirst = mr.stage === "plan" && !mr.report ? planned[0] : mr.report?.diagnostics.find((d) => d.severity === "error");
    const aFirst = ar.report.diagnostics.find((d) => d.severity === "error");
    // A warning the checker gives before anything runs is the earliest signal, even when the run goes on to fail.
    const aWarned = ar.report.diagnostics.filter((d) => d.severity === "warning" && d.code !== "check-failed").map((d) => ({ code: d.code, at: d.at }));
    seeds.push({
      id: s.id,
      what: s.what,
      mission: { stage: mr.stage, ms: mr.scaffoldMs + mr.verifyMs, code: mFirst?.code, at: mFirst?.at, inSpec: located(mFirst, /^(workflow|views|acceptance|uses|callers|host)/), planErrors: planned.length },
      app: { stage: ar.stage, ms: ar.verifyMs, code: aFirst?.code, at: aFirst?.at, inSpec: located(aFirst, /^\/|^acceptance\//), checkWarnings: aWarned }
    });
    process.stdout.write(`${s.id}: mission ${mr.stage}, app ${ar.stage}\n`);
  }

  // The reference application: compiler only (a mission cannot express it).
  const coldSpec = JSON.parse(await readFile(path.join(COLD, "app.json"), "utf8")) as Json;
  const coldDir = await fresh("cold-chain");
  await cp(COLD, coldDir, { recursive: true, filter: (src) => !src.includes(`${path.sep}dist`) });
  const [coldVerify, coldVerifyMs] = await time(() => verifyApp(coldDir));
  const coldLock = Object.keys(JSON.parse(await readFile(path.join(coldDir, "typesys.lock.json"), "utf8")).files as object);
  const coldHand = await files(coldDir, (r) => r.startsWith("src/extensions/"));
  const bundle = (await stat(path.join(coldDir, "dist/client/app.js"))).size;
  const used = JSON.stringify(coldSpec);
  const stepKinds = [...new Set([...used.matchAll(/"kind":"(read|compute|check|ai|approval|action|parallel|forEach)"/g)].map((x) => x[1]!))];
  const nodeKinds = [...new Set([...used.matchAll(/"kind":"(grid|stack|tabs|section|text|metric|chart|table|detail|timeline|graph|map|form|approvals|run|assistant|provenance|actions|custom)"/g)].map((x) => x[1]!))];
  const MISSION_STEPS = ["read", "check", "approval", "action"];
  const generatedImports = new Set<string>();
  for (const r of coldLock) for (const m of (await readFile(path.join(coldDir, r), "utf8")).matchAll(/from "(@typesys\/[a-z-]+)[^"]*"/g)) generatedImports.add(m[1]!);

  const results = {
    format: "typesys.compiler-measurement/1",
    measuredAt: new Date().toISOString(),
    node: process.version,
    machine: "the cloud container this session runs in (shared CPU); timings are indicative, not benchmarks",
    sortie: {
      spec: {
        mission: { leaves: leaves(mission as unknown as Json), bytes: JSON.stringify(mission).length },
        app: { leaves: leaves(app as unknown as Json), bytes: JSON.stringify(app).length, note: "translated by typesys app migrate, which adds a form and an approval queue" }
      },
      generated: { mission: { ...(await size(m0.dir, missionGenerated)), list: missionGenerated }, app: { ...(await size(a0.dir, appGenerated)), list: appGenerated } },
      handwritten: { mission: 0, app: await size(a0.dir, appHandwritten) },
      checks: {
        mission: { passed: m0.report?.checks.filter((c) => c.ok).length, total: mission.acceptance.length, ok: m0.report?.ok },
        app: { passed: a0.report.checks.filter((c) => c.ok).length, total: app.acceptance.length, ok: a0.report.ok }
      },
      timingMs: { missionScaffold: m0.scaffoldMs, missionVerify: m0.verifyMs, appVerify: a0.verifyMs, appCompile: compileRuns, appBuild: buildRuns },
      regeneration: regen,
      seededDefects: seeds
    },
    coldChain: {
      spec: { leaves: leaves(coldSpec), bytes: JSON.stringify(coldSpec).length },
      generated: await size(coldDir, coldLock),
      handwritten: { ...(await size(coldDir, coldHand)), list: coldHand },
      checks: { passed: coldVerify.checks.filter((c) => c.ok).length, total: coldVerify.checks.length, ok: coldVerify.ok },
      verifyMs: coldVerifyMs,
      clientBundleBytes: bundle,
      stepKinds,
      stepKindsAMissionCannotExpress: stepKinds.filter((k) => !MISSION_STEPS.includes(k)),
      nodeKinds,
      nodeKindsAMissionCannotExpress: nodeKinds.filter((k) => k !== "table"),
      existingPackagesTheGeneratedCodeUses: [...generatedImports].sort()
    }
  };
  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, `${JSON.stringify(results, null, 2)}\n`);
  process.stdout.write(`wrote ${path.relative(ROOT, OUT)}\n`);
  if (!existsSync(OUT)) process.exitCode = 1;
}

await main();
// The run is over once the results are written; a handle a measured step leaves open must not keep it alive.
process.exit(process.exitCode ?? 0);
