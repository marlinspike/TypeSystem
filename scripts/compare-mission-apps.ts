/**
 * Measures the squadron readiness application written two ways (ADR-0063):
 * composed from TypeS, and by hand the way the baseline allowed. Run after
 * `npm run build`: `npx tsx scripts/compare-mission-apps.ts`. It needs a
 * Chromium (scripts/find-chrome.ts) for the scenario runs.
 *
 * It reports the code each version needed, the access rules each restates,
 * where each catches a seeded mistake (the compiler, the browser scenario, or
 * nowhere), whether each follows a policy change without edits, and how long
 * each takes to answer the board. The mistakes are a list chosen by hand and
 * printed in full; read the result as what these mistakes show, not a rate.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AirforceModel } from "@typesys/domain-airforce";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = path.join(root, "packages/mission-readiness");
const src = path.join(pkg, "src");
type App = "composed" | "handwritten";
const APPS: readonly App[] = ["composed", "handwritten"];

// ---------------------------------------------------------------- one scenario run, in a child process

if (process.argv[2] === "--scenario") {
  const app = process.argv[3] as App;
  const drift = process.argv.includes("--drift");
  const { chromium } = await import("playwright-core");
  const { requireRole } = await import("@typesys/core");
  const { findChrome } = await import("./find-chrome.js");
  const m = await import("../packages/mission-readiness/src/index.js");
  const { runScenario } = await import("../packages/mission-readiness/test/scenario.js");
  const backend = await m.buildMissionBackend(drift ? { policyOverrides: { "airforce.work-order-assignee": requireRole("maintainer") } } : {});
  const create = app === "composed" ? m.createComposedApp : m.createHandwrittenApp;
  const server = await new Promise<Server>((r) => {
    const s = create(backend, path.join(m.MISSION_CLIENT_DIR, app)).listen(0, "127.0.0.1", () => r(s));
  });
  const browser = await chromium.launch({ executablePath: findChrome()!, args: ["--no-sandbox"] });
  const page = await browser.newPage();
  page.setDefaultTimeout(5_000);
  try {
    const observed = await runScenario(page, `http://127.0.0.1:${(server.address() as { port: number }).port}`);
    console.log(JSON.stringify({ observed }));
  } catch (err) {
    console.log(JSON.stringify({ error: String((err as Error).message).split("\n")[0] }));
  } finally {
    await browser.close();
    server.close();
  }
  process.exit(0);
}

// ---------------------------------------------------------------- code each version needed

/** Lines that are neither blank nor only a comment. */
function codeLines(file: string): number {
  let inBlock = false;
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((raw) => {
      const line = raw.trim();
      if (inBlock) {
        if (line.includes("*/")) inBlock = false;
        return false;
      }
      if (line.startsWith("/*")) {
        inBlock = !line.includes("*/");
        return false;
      }
      return line !== "" && !line.startsWith("//") && !line.startsWith("*");
    }).length;
}

const filesIn = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? filesIn(p) : /\.tsx?$/.test(f) ? [p] : [];
  });

function size(app: App) {
  const files = filesIn(path.join(src, app));
  const client = files.filter((f) => f.includes(`${path.sep}client${path.sep}`));
  const server = files.filter((f) => !client.includes(f));
  const text = (list: string[]) => list.map((f) => readFileSync(f, "utf8")).join("\n");
  return {
    server: server.reduce((n, f) => n + codeLines(f), 0),
    client: client.reduce((n, f) => n + codeLines(f), 0),
    accessRules: (text(files).match(/\/\/ ACCESS:/g) ?? []).length,
    // The client's own declarations of what the server sends.
    wireTypes: (text(client).match(/^interface /gm) ?? []).length
  };
}

// ---------------------------------------------------------------- seeded mistakes

interface Mistake {
  readonly id: string;
  readonly what: string;
  /** Per version: the edits that make the mistake, or why the version has no place to make it. */
  readonly in: Readonly<Record<App, { readonly file: string; readonly edits: readonly (readonly [string, string])[] } | { readonly none: string }>>;
}

const MISTAKES: readonly Mistake[] = [
  {
    id: "property",
    what: "Misspell a property the board shows",
    in: {
      composed: { file: "composed/client/App.tsx", edits: [['"readinessStatus", "deploymentLocation")', '"readinesStatus", "deploymentLocation")']] },
      handwritten: { file: "handwritten/server.ts", edits: [["readinessStatus: a.values.readinessStatus", "readinessStatus: a.values.readinesStatus"]] }
    }
  },
  {
    id: "type",
    what: "Misspell the type the board reads",
    in: {
      composed: { file: "composed/client/App.tsx", edits: [['af.from("airforce.Aircraft")', 'af.from("airforce.Aircrafts")']] },
      handwritten: { file: "handwritten/server.ts", edits: [['{ type: "airforce.Aircraft", select', '{ type: "airforce.Aircrafts", select']] }
    }
  },
  {
    id: "wire",
    what: "Read a field under the wrong name",
    in: {
      composed: { file: "composed/client/App.tsx", edits: [["{a.tailNumber}", "{a.tailNumbr}"]] },
      handwritten: { file: "handwritten/server.ts", edits: [["tailNumber: a.values.tailNumber, model", "tail: a.values.tailNumber, model"]] }
    }
  },
  {
    id: "action-input",
    what: "Misspell an Action's input field",
    in: {
      composed: { file: "composed/client/App.tsx", edits: [["{ maintenanceEventId: eventId,", "{ maintenanceEvent: eventId,"]] },
      handwritten: { file: "handwritten/server.ts", edits: [['{ maintenanceEventId: param(req, "id"),', '{ maintenanceEvent: param(req, "id"),']] }
    }
  },
  {
    id: "status",
    what: "Offer a work-order status the model does not have",
    in: {
      composed: { file: "composed/client/App.tsx", edits: [['["open", "in-progress", "closed"]', '["open", "in_progress", "closed"]']] },
      handwritten: { file: "handwritten/client/App.tsx", edits: [['["open", "in-progress", "closed"]', '["open", "in_progress", "closed"]']] }
    }
  },
  {
    id: "gate",
    what: "Offer opening a work order without asking whether the person may",
    in: {
      composed: { file: "composed/client/App.tsx", edits: [['a.name === "CreateMaintenanceWorkOrder" && a.authorized', 'a.name === "CreateMaintenanceWorkOrder"']] },
      handwritten: { file: "handwritten/server.ts", edits: [["canOpen: isMaintainer(who),", "canOpen: true,"]] }
    }
  },
  {
    id: "restated-rule",
    what: "Restate who may update a work order, leaving out the maintainer role",
    in: {
      composed: { none: "The app holds no copy of the rule; it asks the runtime (useActions)." },
      handwritten: { file: "handwritten/server.ts", edits: [["canUpdate: isMaintainer(who) && (", "canUpdate: ("]] }
    }
  },
  {
    id: "self-approval",
    what: "Let the person who asked approve their own proposal",
    in: {
      composed: { none: "The workflow engine decides who approves (ADR-0057)." },
      handwritten: {
        file: "handwritten/server.ts",
        edits: [
          [".filter((p) => p.initiator.subjectId !== who.subjectId)", ""],
          ["if (!isLead(who) || p.initiator.subjectId === who.subjectId)", "if (!isLead(who))"]
        ]
      }
    }
  },
  {
    id: "model-check",
    what: "Trust the triage model's answer without checking it names this aircraft's event",
    in: {
      composed: { none: "The workflow's proposal step checks it, in the domain (ADR-0057)." },
      handwritten: {
        file: "handwritten/server.ts",
        edits: [["if (typeof answer?.eventId !== \"string\" || !history.some((e) => e.id === answer.eventId)) throw new PreconditionFailedError(\"The triage named an event that is not in this aircraft's history\");", ""]]
      }
    }
  }
];

const tsc = path.join(root, "tools/eslint/node_modules/typescript/bin/tsc");
const checkConfig = path.join(root, "tools/eslint/tsconfig.mission.json");

function compiles(): boolean {
  try {
    execFileSync(process.execPath, [tsc, "-p", checkConfig], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}
const buildClients = () => execFileSync(process.execPath, [path.join(root, "node_modules/tsx/dist/cli.mjs"), path.join(root, "scripts/build-clients.ts")], { stdio: "pipe" });

function scenario(app: App, drift = false): { observed?: unknown; error?: string } {
  const run = spawnSync(process.execPath, [path.join(root, "node_modules/tsx/dist/cli.mjs"), fileURLToPath(import.meta.url), "--scenario", app, ...(drift ? ["--drift"] : [])], {
    encoding: "utf8",
    timeout: 120_000
  });
  const line = run.stdout.trim().split("\n").at(-1) ?? "";
  try {
    return JSON.parse(line) as { observed?: unknown; error?: string };
  } catch {
    return { error: run.stderr.trim().split("\n").at(-1) ?? "no output" };
  }
}

const { EXPECTED } = await import("../packages/mission-readiness/test/scenario.js");
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

type Caught = "compile" | "scenario" | "silent" | "n/a";
const results: { id: string; what: string; composed: Caught; handwritten: Caught }[] = [];

if (!compiles()) throw new Error("The mission application does not compile before any mistake is seeded");
for (const app of APPS) if (!same(scenario(app).observed, EXPECTED)) throw new Error(`The ${app} version fails the scenario before any mistake is seeded`);

for (const mistake of MISTAKES) {
  const row = { id: mistake.id, what: mistake.what } as (typeof results)[number];
  for (const app of APPS) {
    const where = mistake.in[app];
    if ("none" in where) {
      row[app] = "n/a";
      continue;
    }
    const file = path.join(src, where.file);
    const original = readFileSync(file, "utf8");
    let edited = original;
    for (const [from, to] of where.edits) {
      if (!edited.includes(from)) throw new Error(`Mistake ${mistake.id} (${app}): "${from}" is not in ${where.file}`);
      edited = edited.replace(from, to);
    }
    writeFileSync(file, edited);
    try {
      if (!compiles()) row[app] = "compile";
      else {
        if (where.file.includes("client")) buildClients();
        row[app] = same(scenario(app).observed, EXPECTED) ? "silent" : "scenario";
      }
    } finally {
      writeFileSync(file, original);
    }
  }
  results.push(row);
  console.error(`seeded ${mistake.id}: composed ${row.composed}, hand-written ${row.handwritten}`);
}
buildClients();

// ---------------------------------------------------------------- a policy change, with no edit to either version

const drifted = { ...EXPECTED, maintainerCanUpdateOthers: true };
const drift = Object.fromEntries(APPS.map((app) => [app, same(scenario(app, true).observed, drifted)])) as Record<App, boolean>;

// ---------------------------------------------------------------- the board's latency

const { buildMissionBackend, createComposedApp, createHandwrittenApp, MISSION_CLIENT_DIR } = await import("../packages/mission-readiness/src/index.js");
const { createClient, httpTransport } = await import("@typesys/sdk");

async function boardTimes(app: App, latencyMs: number, runs = 40) {
  const backend = await buildMissionBackend({ maintenanceLatencyMs: latencyMs });
  const create = app === "composed" ? createComposedApp : createHandwrittenApp;
  const server = await new Promise<Server>((r) => {
    const s = create(backend, path.join(MISSION_CLIENT_DIR, app)).listen(0, "127.0.0.1", () => r(s));
  });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const token = "mission-maintainer-token";
  const client = createClient<AirforceModel>(httpTransport({ baseUrl: `${base}/api`, token }));
  // Each version's board, as its client asks for it.
  const load =
    app === "composed"
      ? () =>
          client
            .from("airforce.Aircraft")
            .where((a) => a.needsAttention.eq(true))
            .select("tailNumber", "model", "readinessStatus", "deploymentLocation")
            .orderBy("tailNumber")
            .limit(50)
            .page()
      : () => fetch(`${base}/app/board`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.json());
  const times: number[] = [];
  for (let i = 0; i < runs + 5; i++) {
    const t = performance.now();
    await load();
    if (i >= 5) times.push(performance.now() - t);
  }
  server.close();
  times.sort((a, b) => a - b);
  const at = (q: number) => times[Math.min(times.length - 1, Math.floor(q * times.length))]!.toFixed(1);
  return `${at(0.5)} / ${at(0.95)}`;
}

const latency = [];
for (const ms of [0, 2]) latency.push({ ms, composed: await boardTimes("composed", ms), handwritten: await boardTimes("handwritten", ms) });

// ---------------------------------------------------------------- report

const sizes = { composed: size("composed"), handwritten: size("handwritten") };
const out: string[] = [];
out.push("| | Composed from TypeS | Written by hand |", "|---|---|---|");
out.push(`| Server, lines of code | ${sizes.composed.server} | ${sizes.handwritten.server} |`);
out.push(`| Client, lines of code | ${sizes.composed.client} | ${sizes.handwritten.client} |`);
out.push(`| Total | ${sizes.composed.server + sizes.composed.client} | ${sizes.handwritten.server + sizes.handwritten.client} |`);
out.push(`| Access rules restated in the app | ${sizes.composed.accessRules} | ${sizes.handwritten.accessRules} |`);
out.push(`| Wire types kept in step by hand | ${sizes.composed.wireTypes} | ${sizes.handwritten.wireTypes} |`);
out.push(`| Follows a policy change with no edit | ${drift.composed ? "yes" : "no"} | ${drift.handwritten ? "yes" : "no"} |`);
out.push("", "| Seeded mistake | Composed | Hand-written |", "|---|---|---|");
for (const r of results) out.push(`| ${r.what} | ${r.composed} | ${r.handwritten} |`);
out.push("", "| Maintenance latency per call | Composed board p50 / p95 (ms) | Hand-written board p50 / p95 (ms) |", "|---|---|---|");
for (const l of latency) out.push(`| ${l.ms} ms | ${l.composed} | ${l.handwritten} |`);
console.log(out.join("\n"));
