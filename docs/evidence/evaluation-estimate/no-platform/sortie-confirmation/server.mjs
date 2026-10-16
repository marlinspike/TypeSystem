// sortie-confirmation, written by hand under the agent-without arm's packages:
// the runtime, its policy engine and the sortie domain; no @typesys/http, no @typesys/workflow.
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { AuthorizationError, NotFoundError, InvalidInputError, decideForIdentity } from "@typesys/core";
import { buildSortieHost, resolveSortieIdentity } from "@typesys/sortie-readiness";

const host = await buildSortieHost({ rosterPii: true });
const { runtime, policyEngine } = host;
const WORKFLOW = "ops.ConfirmSortie";
const STEP = "plannerSignoff";
/** runId -> { initiator, input, status, waitingOn? } (in memory: no journal, no recovery). */
const runs = new Map();

async function allowed(identity, policyName, actionName) {
  const d = await decideForIdentity(policyEngine, { subject: identity, action: "invoke", policyName, resource: { typeName: WORKFLOW, actionName } });
  return d.allow;
}
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function startRun(identity, input) {
  if (!(await allowed(identity, "ops.crew", "start"))) throw new HttpError(403, `Not authorized: start ${WORKFLOW}`);
  const { tailNumber, pilotId } = input ?? {};
  if (typeof tailNumber !== "string" || !tailNumber || typeof pilotId !== "string" || !pilotId) throw new HttpError(400, "tailNumber and pilotId are required");
  const runId = randomUUID();
  const run = { initiator: identity, input: { tailNumber, pilotId }, status: "failed" };
  runs.set(runId, run);
  try {
    const aircraft = await runtime.getObject("ops.Aircraft", tailNumber, identity);
    const pilot = await runtime.getObject("ops.CrewMember", pilotId, identity);
    // The pilot must be assigned to this aircraft.
    if (pilot.values.assignedTail !== undefined && pilot.values.assignedTail === aircraft.values.tailNumber) {
      run.status = "waiting-approval";
      run.waitingOn = { step: STEP };
    }
  } catch {
    run.status = "failed";
  }
  return { runId, status: run.status, ...(run.waitingOn ? { waitingOn: run.waitingOn } : {}) };
}

async function mayApprove(identity, run) {
  if (run.initiator.subjectId === identity.subjectId) return false; // never one they asked for themselves
  return allowed(identity, "ops.sortie-signoff", STEP);
}

async function approveRun(identity, runId, step, body) {
  const run = runs.get(runId);
  if (!run) throw new HttpError(404, "no such run");
  if (step !== STEP || run.status !== "waiting-approval") throw new HttpError(409, `run is not waiting on ${step}`);
  if (!(await mayApprove(identity, run))) throw new HttpError(403, `Not authorized: approve ${step}`);
  run.status = body?.approved === true ? "completed" : "failed";
  delete run.waitingOn;
  return { status: run.status };
}

async function readRun(identity, runId) {
  const run = runs.get(runId);
  const visible = run && (run.initiator.subjectId === identity.subjectId || (run.status === "waiting-approval" && (await mayApprove(identity, run))));
  if (!visible) throw new HttpError(404, "no such run");
  return { status: run.status };
}

async function route(method, url, identity, body) {
  const parts = url.split("?")[0].split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] !== "api") throw new HttpError(404, "not found");
  const [, a, b, c, d] = parts;
  if (method === "GET" && a === "me" && parts.length === 2) return [200, { subjectId: identity.subjectId, roles: identity.roles }];
  if (method === "GET" && a === "objects" && parts.length === 4) {
    const o = await runtime.getObject(b, c, identity);
    return [200, { values: o.values }];
  }
  if (method === "POST" && a === "query" && parts.length === 2) {
    const r = await runtime.query({ type: body?.type, ...(body?.filter ? { filter: body.filter } : {}) }, identity);
    return [200, { items: r.items.map((i) => ({ objectId: i.objectId, values: i.values })) }];
  }
  if (method === "POST" && a === "workflows" && c === "runs" && parts.length === 4) {
    if (b !== WORKFLOW) throw new HttpError(404, `unknown workflow ${b}`);
    return [201, await startRun(identity, body?.input)];
  }
  if (method === "POST" && a === "workflow-runs" && c === "approvals" && parts.length === 5) return [200, await approveRun(identity, b, d, body)];
  if (method === "GET" && a === "workflow-runs" && parts.length === 3) return [200, await readRun(identity, b)];
  throw new HttpError(404, "not found");
}

function statusOf(err) {
  if (err instanceof HttpError) return err.status;
  if (err instanceof AuthorizationError) return 403;
  if (err instanceof NotFoundError) return 404;
  if (err instanceof InvalidInputError) return 400;
  return 500;
}

const server = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const auth = req.headers.authorization ?? "";
  const identity = await resolveSortieIdentity(auth.startsWith("Bearer ") ? auth.slice(7) : "");
  let status, payload;
  try {
    [status, payload] = await route(req.method, req.url, identity, raw ? JSON.parse(raw) : undefined);
  } catch (err) {
    status = statusOf(err);
    payload = { error: status === 500 ? "internal error" : err.message };
  }
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(payload));
});
server.listen(Number(process.env.PORT ?? 4700), "127.0.0.1", () => console.log(`sortie-confirmation on ${process.env.PORT}`));
