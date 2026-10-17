// Recall response: the governed API over the cold chain host and the recall exchange.
import { spawn } from "node:child_process";
import path from "node:path";
import { AuthorizationError, buildRuntime, coreManifest } from "@typesys/core";
import {
  SERVICES_DIR,
  buildColdChainHost,
  coldChainClassification,
  coldChainIdentities,
  coldChainManifest,
  coldChainPolicyRules,
  coldChainUrlsFromEnv,
  inventoryAdapter,
  resolveColdChainIdentity,
  sensorAdapter,
  trackerAdapter
} from "@typesys/cold-chain";
import { createApiApp } from "@typesys/http";
import { WorkflowEngine } from "@typesys/workflow";
import { WORKFLOW, insideRun, recallAdapter, recallManifest, recallPolicyRules, withRecallActions } from "./model.mjs";
import { respondToRecall } from "./workflow.mjs";

/** Dr. Tomasz Brandt: quality assurance, as Dr. Raman is; the host does not know his token. */
const qa2 = { subjectId: "user-qa-2", roles: ["qa"], attributes: { displayName: "Dr. Tomasz Brandt" }, clearance: "CONFIDENTIAL" };
const extraTokens = { "demo-qa2-token": qa2 };

export async function resolveIdentity(token) {
  if (token && Object.hasOwn(extraTokens, token)) return structuredClone(extraTokens[token]);
  return resolveColdChainIdentity(token);
}

/** Everyone a run may be carried by or signed off by, by subject id. */
const people = new Map([...Object.values(coldChainIdentities), qa2].filter((i) => i.subjectId !== "anonymous").map((i) => [i.subjectId, i]));
const directory = { displayNameOf: (subjectId) => people.get(subjectId)?.attributes?.displayName };

/** The recall exchange: a fourth independent service, in its own process. */
function startRecallExchange() {
  const child = spawn(process.execPath, [path.join(SERVICES_DIR, "recall-exchange", "server.mjs")], {
    env: { ...process.env, PORT: "0", EXIT_WITH_PARENT: "1" },
    stdio: ["pipe", "pipe", "pipe"]
  });
  process.once("exit", () => child.kill());
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`recall-exchange did not start: ${output}`)), 10_000);
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      const m = / on (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    child.stderr.on("data", (chunk) => (output += chunk.toString()));
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`recall-exchange exited (${code}): ${output}`));
    });
  });
}

export async function buildRecallHost() {
  // The cold chain host starts the tracker, the sensor hub and the pharmacy inventory (or uses the URLs it is given).
  const host = await buildColdChainHost();
  const urls = coldChainUrlsFromEnv() ?? { tracker: host.services.tracker.url, sensors: host.services.sensors.url, inventory: host.services.inventory.url };
  const exchangeUrl = process.env.TYPESYS_RECALL_EXCHANGE_URL ?? (await startRecallExchange());
  // The same model, adapters, keys and policy as the host, with the exchange beside them.
  const built = await buildRuntime({
    manifests: [coreManifest, coldChainManifest, recallManifest],
    adapters: [trackerAdapter(urls.tracker), sensorAdapter(urls.sensors), withRecallActions(inventoryAdapter(urls.inventory)), recallAdapter(exchangeUrl)],
    policyRules: { ...coldChainPolicyRules, ...recallPolicyRules },
    runtimeOptions: { resilience: { callTimeoutMs: 2_000 }, classification: coldChainClassification, inspection: { policy: "coldchain.inspect" } }
  });
  return { ...built, services: host.services, urls: { ...urls, exchange: exchangeUrl } };
}

export async function createServer() {
  const backend = await buildRecallHost();
  const workflows = await WorkflowEngine.create({
    host: backend,
    // A run continues as its initiator is now, from the directory.
    resolveIdentity: async (snapshot) => {
      const now = people.get(snapshot.subjectId);
      if (!now) throw new AuthorizationError(`No such person ${snapshot.subjectId}`, "unknown subject");
      return structuredClone(now);
    }
  });
  workflows.register(respondToRecall(directory));

  // The response's writes are made only by the engine, inside a run: never as a bare Action call.
  const invoke = workflows.invokeAction.bind(workflows);
  workflows.invokeAction = (action, input, identity, state) => insideRun.run({ runId: state?.runId ?? true }, () => invoke(action, input, identity, state));

  // Asking to respond to a notice you may not read (an embargoed one, unless quality assurance) is refused outright.
  const start = workflows.start.bind(workflows);
  workflows.start = async (name, input, initiator) => {
    if (name === WORKFLOW && input && typeof input === "object" && typeof input.recallId === "string" && input.recallId !== "") {
      // The start policy is decided first (by the engine, and audited there), so a caller who may not start at all is told that.
      const may = await backend.policyEngine.evaluate({ subject: initiator, action: "invoke", policyName: "coldchain.recall-respond", resource: { typeName: WORKFLOW, actionName: "start" } });
      if (may.allow) {
        try {
          await backend.runtime.getObject("coldchain.Recall", input.recallId, initiator);
        } catch (err) {
          if (err instanceof AuthorizationError) throw new AuthorizationError(`Not authorized: start ${WORKFLOW} for ${input.recallId}`, "The notice is not one you may read");
        }
      }
    }
    return start(name, input, initiator);
  };

  const app = createApiApp({ backend, identityResolver: resolveIdentity, workflows, info: { title: "Recall response" } });
  return { app, backend, workflows };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 3000);
  const { app, backend } = await createServer();
  app.listen(port, "127.0.0.1", () => {
    console.log(`recall-response on http://127.0.0.1:${port} (exchange ${backend.urls.exchange})`);
  });
}
