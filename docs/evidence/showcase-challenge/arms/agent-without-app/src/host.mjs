// The governed runtime: the cold chain host's model, adapters and rules, with
// the recall exchange added as a fourth independent service.
import { spawn } from "node:child_process";
import path from "node:path";
import { buildRuntime, coreManifest } from "@typesys/core";
import {
  SERVICES_DIR,
  coldChainClassification,
  coldChainIdentities,
  coldChainManifest,
  coldChainPolicyRules,
  coldChainUrlsFromEnv,
  inventoryAdapter,
  resolveColdChainIdentity,
  sensorAdapter,
  startServices,
  trackerAdapter
} from "@typesys/cold-chain";
import { recallAdapter, recallManifest, recallPolicyRules } from "./recall-model.mjs";

/** Starts the recall exchange in its own process on a free port. */
export function startRecallExchange() {
  const child = spawn(process.execPath, [path.join(SERVICES_DIR, "recall-exchange", "server.mjs")], {
    env: { ...process.env, PORT: "0", EXIT_WITH_PARENT: "1" },
    stdio: ["pipe", "pipe", "pipe"]
  });
  process.once("exit", () => child.kill());
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`recall-exchange did not start: ${output}`));
    }, 10_000);
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      const m = / on (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
      if (m) {
        clearTimeout(timer);
        resolve({ url: m[1], process: child });
      }
    });
    child.stderr.on("data", (chunk) => (output += chunk.toString()));
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`recall-exchange exited (${code}) before it listened: ${output}`));
    });
  });
}

/** The cold chain host's runtime, with coldchain.Recall over the recall exchange. */
export async function buildRecallHost() {
  const given = coldChainUrlsFromEnv();
  const services = given ? undefined : await startServices();
  const urls = given ?? { tracker: services.tracker.url, sensors: services.sensors.url, inventory: services.inventory.url };
  const recallUrl = process.env.TYPESYS_COLDCHAIN_RECALLS_URL ?? process.env.RECALL_EXCHANGE_URL ?? (await startRecallExchange()).url;
  const built = await buildRuntime({
    manifests: [coreManifest, coldChainManifest, recallManifest],
    adapters: [trackerAdapter(urls.tracker), sensorAdapter(urls.sensors), inventoryAdapter(urls.inventory), recallAdapter(recallUrl)],
    policyRules: { ...coldChainPolicyRules, ...recallPolicyRules },
    runtimeOptions: { resilience: { callTimeoutMs: 5_000 }, classification: coldChainClassification, inspection: { policy: "coldchain.inspect" } }
  });
  return { ...built, urls: { ...urls, recalls: recallUrl } };
}

/** Dr. Tomasz Brandt: quality assurance, as Dr. Raman is, whom the host's resolver does not know. */
const QA2 = Object.freeze({ subjectId: "user-qa-2", roles: ["qa"], attributes: { displayName: "Dr. Tomasz Brandt" }, clearance: "CONFIDENTIAL" });

/** The bearer token as a person: the host's demo identities, and Dr. Brandt. Anything else is someone not signed in. */
export async function resolveIdentity(token) {
  if (token === "demo-qa2-token") return structuredClone(QA2);
  const found = await resolveColdChainIdentity(token);
  return structuredClone(found ?? coldChainIdentities.anonymous);
}

export const isSignedIn = (identity) => identity.subjectId !== "anonymous" && identity.roles.length > 0;
export const displayNameOf = (identity) => (typeof identity.attributes?.displayName === "string" ? identity.attributes.displayName : identity.subjectId);
