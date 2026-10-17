/**
 * TypeSys Studio (ADR-0061) over one of the example domains:
 *
 *   npm run build && npm run studio                        # the Air Force demo on :4400
 *   TYPESYS_STUDIO_DOMAIN=cold-chain npm run studio        # Cold Chain on :4400 (the showcase uses :4401)
 *
 * The header offers the domain's demo tokens and anonymous access, so the
 * same screens can be compared as each. Demo tokens are for a demonstration
 * only (ADR-0050).
 *
 * Air Force: the lead may inspect (ADR-0088), so signed in as the lead the
 * Graph and Explain tabs show sources, policies and markings, and explain
 * anyone's access. `TYPESYS_APP=<dir>/app.json` adds a 4.0 application to
 * the graph. `TYPESYS_DISCOVERY=need-to-know npm run studio` shows each
 * caller only the part of the model they could use (ADR-0068).
 *
 * Cold Chain: the cold chain and the recall exchange, four systems on one
 * runtime (`buildRecallHost`). Quality assurance and the auditor may inspect.
 * The graph reaches the pages, data, checks and workflows of Cold Chain
 * Command and the Recall Response, which need the applications built
 * (`npx typesys app build examples/apps/cold-chain`, and the same for
 * examples/apps/recall-response). With TYPESYS_COLDCHAIN_*_URL set (the
 * showcase sets them), Studio reads the same running services as the
 * applications.
 */
import { describeModel, type Discovery } from "@typesys/core";
import { appUses, type AppSpec } from "@typesys/compiler";
import { buildAirforceWorkbench, demoAudiences, demoIdentities, groundForRepair, resolveDemoIdentity } from "@typesys/domain-airforce";
import { createStudioApp, type StudioOptions } from "@typesys/studio";
import { WorkflowEngine, scriptedModel, type AnyWorkflow } from "@typesys/workflow";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const COLD_CHAIN_APPS = [
  { dir: path.join(ROOT, "examples/apps/cold-chain"), flows: ["assess", "disposition"] },
  { dir: path.join(ROOT, "examples/apps/recall-response"), flows: ["respond"] }
];

async function airforceStudio(): Promise<StudioOptions> {
  const discovery = (process.env.TYPESYS_DISCOVERY ?? "open") as Discovery;
  const testbed = await buildAirforceWorkbench({ runtimeOptions: { discovery } });
  const workflows = await WorkflowEngine.create({ host: testbed, model: scriptedModel({}, "scripted", demoAudiences.enclaveModel) });
  workflows.register(groundForRepair);
  const people = [demoIdentities.maintainer, demoIdentities.viewer, demoIdentities.lead];
  return {
    backend: testbed,
    identityResolver: resolveDemoIdentity,
    workflows,
    // TYPESYS_APP=<app.json> adds an application built on the model, so the graph reaches its pages and checks.
    consumers: process.env.TYPESYS_APP ? appUses(JSON.parse(await readFile(process.env.TYPESYS_APP, "utf8")) as AppSpec, await describeModel(testbed.registry)) : [],
    subjects: { list: async () => people.map((p) => ({ subjectId: p.subjectId })), resolve: async (id) => people.find((p) => p.subjectId === id) },
    title: "TypeSys Studio · airforce demo",
    demoTokens: { Lead: "demo-lead-token", Maintainer: "demo-maintainer-token", Viewer: "demo-viewer-token" }
  };
}

async function coldChainStudio(): Promise<StudioOptions> {
  const { buildRecallHost, recallPeople, resolveRecallIdentity } = await import("@typesys/cold-chain");
  const host = await buildRecallHost();
  // Each application's own compiled flows, so Studio explains and graphs the workflows the applications run.
  const flows: AnyWorkflow[] = [];
  const consumers = [];
  const model = await describeModel(host.registry);
  for (const app of COLD_CHAIN_APPS) {
    consumers.push(...appUses(JSON.parse(await readFile(path.join(app.dir, "app.json"), "utf8")) as AppSpec, model));
    const flowsDir = path.join(app.dir, "dist/src/generated/flows");
    if (!existsSync(flowsDir)) {
      console.warn(`${path.basename(app.dir)} is not built (${flowsDir} is missing): Studio shows the model without its workflows. Run: npx typesys app build ${path.relative(ROOT, app.dir)}`);
      continue;
    }
    for (const name of app.flows) flows.push((await import(pathToFileURL(path.join(flowsDir, `${name}.js`)).href))[name] as AnyWorkflow);
  }
  // Studio explains and graphs workflows; it never runs their AI steps, so the model here only names the audience.
  const stability = scriptedModel({}, "scripted", { id: "model:coldchain-enclave/stability", kind: "model", roles: ["coldchain-model"], attributes: {}, clearance: "INTERNAL" });
  const workflows = await WorkflowEngine.create({ host, models: { stability } });
  for (const flow of flows) workflows.register(flow);
  const { anonymous: _anonymous, ...people } = recallPeople;
  return {
    backend: host,
    identityResolver: resolveRecallIdentity,
    workflows,
    consumers,
    subjects: { list: async () => Object.values(people).map((p) => ({ subjectId: p.subjectId })), resolve: async (id) => Object.values(people).find((p) => p.subjectId === id) },
    title: "TypeSys Studio · Cold Chain",
    demoTokens: { QA: "demo-qa-token", "QA 2": "demo-qa2-token", Auditor: "demo-auditor-token", Logistics: "demo-logistics-token", Carrier: "demo-carrier-token" }
  };
}

const domain = process.env.TYPESYS_STUDIO_DOMAIN ?? "airforce";
if (domain !== "airforce" && domain !== "cold-chain") throw new Error(`TYPESYS_STUDIO_DOMAIN is "airforce" or "cold-chain", not "${domain}"`);
const app = createStudioApp(domain === "cold-chain" ? await coldChainStudio() : await airforceStudio());
const port = Number(process.env.PORT ?? 4400);
app.listen(port, "127.0.0.1", () => console.log(`TypeSys Studio (${domain}) on http://localhost:${port}`));
