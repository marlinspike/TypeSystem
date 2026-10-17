/**
 * TypeSys Studio over the airforce demo (ADR-0061): `npm run build && npm run studio`,
 * then open http://localhost:4400. The header offers the demo's maintainer and
 * viewer tokens and anonymous access, so the same screens can be compared as
 * each. Demo tokens are for a demonstration only (ADR-0050).
 *
 * `TYPESYS_DISCOVERY=need-to-know npm run studio` shows each caller only the
 * part of the model they could use, and anonymous access nothing (ADR-0068).
 *
 * The lead may inspect (ADR-0088), so signed in as the lead the Graph and
 * Explain tabs show sources, policies and markings, and explain anyone's
 * access. `TYPESYS_APP=<dir>/app.json` adds a 4.0 application to the graph.
 */
import { describeModel, type Discovery } from "@typesys/core";
import { appUses } from "@typesys/compiler";
import { buildAirforceWorkbench, demoAudiences, demoIdentities, groundForRepair, resolveDemoIdentity } from "@typesys/domain-airforce";
import { createStudioApp } from "@typesys/studio";
import { WorkflowEngine, scriptedModel } from "@typesys/workflow";
import { readFile } from "node:fs/promises";

const discovery = (process.env.TYPESYS_DISCOVERY ?? "open") as Discovery;
// The lead may inspect (ADR-0088): the Graph and Explain tabs show sources, policies and markings to them.
const testbed = await buildAirforceWorkbench({ runtimeOptions: { discovery } });
const workflows = await WorkflowEngine.create({ host: testbed, model: scriptedModel({}, "scripted", demoAudiences.enclaveModel) });
workflows.register(groundForRepair);
const people = [demoIdentities.maintainer, demoIdentities.viewer, demoIdentities.lead];
const app = createStudioApp({
  backend: testbed,
  identityResolver: resolveDemoIdentity,
  workflows,
  // TYPESYS_APP=<app.json> adds an application built on the model, so the graph reaches its pages and checks.
  consumers: process.env.TYPESYS_APP ? appUses(JSON.parse(await readFile(process.env.TYPESYS_APP, "utf8")), await describeModel(testbed.registry)) : [],
  subjects: { list: async () => people.map((p) => ({ subjectId: p.subjectId })), resolve: async (id) => people.find((p) => p.subjectId === id) },
  title: "TypeSys Studio · airforce demo",
  demoTokens: { Lead: "demo-lead-token", Maintainer: "demo-maintainer-token", Viewer: "demo-viewer-token" }
});
const port = Number(process.env.PORT ?? 4400);
app.listen(port, "127.0.0.1", () => console.log(`TypeSys Studio on http://localhost:${port}`));
