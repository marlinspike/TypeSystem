// The file step fails after the lots were held: the hold is undone.
import { WorkflowEngine } from "@typesys/workflow";
import { buildRecallHost, resolveIdentity } from "../src/server.mjs";
import { insideRun } from "../src/model.mjs";
import { respondToRecall } from "../src/workflow.mjs";
const backend = await buildRecallHost();
const engine = await WorkflowEngine.create({ host: backend, faults: { file: [{ error: new Error("exchange rejected the response") }] } });
engine.register(respondToRecall({ displayNameOf: () => "Dr. Priya Raman" }));
const invoke = engine.invokeAction.bind(engine);
engine.invokeAction = (...a) => insideRun.run({ runId: true }, () => invoke(...a));
const dana = await resolveIdentity("demo-logistics-token"), priya = await resolveIdentity("demo-qa-token");
const run = await engine.start("coldchain.RespondToRecall", { recallId: "RCL-26-0412" }, dana);
const done = await engine.approve(run.runId, "qaSignoff", priya, { approved: true });
console.log(done.status, done.reason);
for (const id of ["L-7701", "L-7731"]) console.log(id, (await backend.runtime.getObject("coldchain.Lot", id, priya)).values.status);
console.log((await backend.runtime.getObject("coldchain.Recall", "RCL-26-0412", priya)).values.responseStatus);
process.exit(0);
