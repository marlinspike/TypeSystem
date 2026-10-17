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
 * Cold Chain: quality assurance and the auditor may inspect. The graph
 * reaches Cold Chain Command's pages, data and checks and its two workflows,
 * which need the application built (`npx typesys app build
 * examples/apps/cold-chain`). With TYPESYS_COLDCHAIN_*_URL set (the showcase
 * sets them), Studio reads the same running services as the application.
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
const COLD_CHAIN_APP = path.join(ROOT, "examples/apps/cold-chain");

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
  const { buildColdChainHost, coldChainIdentities, resolveColdChainIdentity } = await import("@typesys/cold-chain");
  const host = await buildColdChainHost();
  const spec = JSON.parse(await readFile(path.join(COLD_CHAIN_APP, "app.json"), "utf8")) as AppSpec;
  // The application's own compiled flows, so Studio explains and graphs the workflows the application runs.
  const flowsDir = path.join(COLD_CHAIN_APP, "dist/src/generated/flows");
  const flows: AnyWorkflow[] = [];
  if (existsSync(flowsDir)) {
    for (const name of ["assess", "disposition"]) flows.push((await import(pathToFileURL(path.join(flowsDir, `${name}.js`)).href))[name] as AnyWorkflow);
  } else console.warn(`Cold Chain Command is not built (${flowsDir} is missing): Studio shows the model without its workflows. Run: npx typesys app build examples/apps/cold-chain`);
  // Studio explains and graphs workflows; it never runs their AI steps, so the model here only names the audience.
  const stability = scriptedModel({}, "scripted", { id: "model:coldchain-enclave/stability", kind: "model", roles: ["coldchain-model"], attributes: {}, clearance: "INTERNAL" });
  const workflows = await WorkflowEngine.create({ host, models: { stability } });
  for (const flow of flows) workflows.register(flow);
  const { anonymous: _anonymous, ...people } = coldChainIdentities;
  return {
    backend: host,
    identityResolver: resolveColdChainIdentity,
    workflows,
    consumers: appUses(spec, await describeModel(host.registry)),
    subjects: { list: async () => Object.values(people).map((p) => ({ subjectId: p.subjectId })), resolve: async (id) => Object.values(people).find((p) => p.subjectId === id) },
    title: "TypeSys Studio · Cold Chain",
    demoTokens: { QA: "demo-qa-token", Auditor: "demo-auditor-token", Logistics: "demo-logistics-token", Carrier: "demo-carrier-token" }
  };
}

const domain = process.env.TYPESYS_STUDIO_DOMAIN ?? "airforce";
if (domain !== "airforce" && domain !== "cold-chain") throw new Error(`TYPESYS_STUDIO_DOMAIN is "airforce" or "cold-chain", not "${domain}"`);
const app = createStudioApp(domain === "cold-chain" ? await coldChainStudio() : await airforceStudio());
const port = Number(process.env.PORT ?? 4400);
app.listen(port, "127.0.0.1", () => console.log(`TypeSys Studio (${domain}) on http://localhost:${port}`));
