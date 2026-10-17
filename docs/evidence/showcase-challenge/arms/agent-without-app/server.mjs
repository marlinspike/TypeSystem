// Recall response: the governed HTTP API over the cold chain and the recall exchange.
import { createServer } from "node:http";
import { AuthorizationError, InvalidInputError, NotFoundError } from "@typesys/core";
import { buildRecallHost, displayNameOf, isSignedIn, resolveIdentity } from "./src/host.mjs";
import { RecallWorkflow, WorkflowError, runView } from "./src/workflow.mjs";

const host = await buildRecallHost();
const workflow = new RecallWorkflow(host);
const { runtime } = host;

function send(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(payload));
}

async function readBody(req) {
  let text = "";
  for await (const chunk of req) text += chunk;
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new WorkflowError(400, "The body is not JSON");
  }
}

function tokenOf(req) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "");
  return m ? m[1].trim() : undefined;
}

/** The runtime's and the workflow's errors as HTTP answers. */
function fail(res, err) {
  if (err instanceof WorkflowError) return send(res, err.status, { error: err.message });
  if (err instanceof AuthorizationError) return send(res, 403, { error: "Forbidden", reason: err.reason ?? err.message });
  if (err instanceof NotFoundError) return send(res, 404, { error: "Not found" });
  if (err instanceof InvalidInputError) return send(res, 400, { error: err.message });
  console.error(err);
  return send(res, 502, { error: err instanceof Error ? err.message : String(err) });
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (parts[0] !== "api") return send(res, 404, { error: "Not found" });
    const identity = await resolveIdentity(tokenOf(req));
    const route = parts.slice(1);
    const method = req.method ?? "GET";

    if (method === "GET" && route.length === 1 && route[0] === "me") {
      return send(res, 200, { subjectId: identity.subjectId, displayName: isSignedIn(identity) ? displayNameOf(identity) : null, roles: identity.roles, signedIn: isSignedIn(identity) });
    }

    // Someone not signed in sees nothing and may do nothing.
    const anonymous = !isSignedIn(identity);

    if (method === "GET" && route.length === 3 && route[0] === "objects") {
      if (anonymous) return send(res, 403, { error: "Sign in to read" });
      const object = await runtime.getObject(route[1], route[2], identity);
      return send(res, 200, { objectId: object.objectId, type: object.typeName, values: object.values });
    }

    if (method === "POST" && route.length === 1 && route[0] === "query") {
      if (anonymous) return send(res, 403, { error: "Sign in to query" });
      const body = await readBody(req);
      if (typeof body?.type !== "string") return send(res, 400, { error: "type is required" });
      const query = { type: body.type, ...(body.filter !== undefined ? { filter: body.filter } : {}), ...(body.limit !== undefined ? { limit: body.limit } : {}), ...(body.cursor !== undefined ? { cursor: body.cursor } : {}), ...(body.sort !== undefined ? { sort: body.sort } : {}) };
      const result = await runtime.query(query, identity);
      return send(res, 200, { items: result.items.map((i) => ({ objectId: i.objectId, values: i.values })), ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}) });
    }

    if (method === "POST" && route.length === 3 && route[0] === "workflows" && route[2] === "runs") {
      const body = await readBody(req);
      if (anonymous) return send(res, 403, { error: "Sign in to start a workflow" });
      const run = await workflow.start(route[1], body?.input ?? {}, identity);
      return send(res, 201, runView(run));
    }

    if (route[0] === "workflow-runs" && route.length >= 2) {
      const runId = route[1];
      if (method === "GET" && route.length === 2) {
        const run = await workflow.get(runId, identity);
        return send(res, 200, runView(run));
      }
      if (method === "POST" && route.length === 4 && route[2] === "approvals") {
        const body = await readBody(req);
        const run = await workflow.approve(runId, route[3], body, identity);
        return send(res, 200, runView(run));
      }
    }
    return send(res, 404, { error: "Not found" });
  } catch (err) {
    return fail(res, err);
  }
});

const port = Number(process.env.PORT ?? 3000);
server.listen(port, "127.0.0.1", () => {
  console.log(`recall-response on http://127.0.0.1:${server.address().port}`);
});
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => process.exit(0));
