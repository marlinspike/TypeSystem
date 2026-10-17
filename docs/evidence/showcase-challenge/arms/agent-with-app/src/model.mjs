// The recall exchange as part of the cold chain model: the Type
// coldchain.Recall, the Actions a recall response takes, and who may do what.
import { AsyncLocalStorage } from "node:async_hooks";
import { HttpAdapter } from "@typesys/adapter-http";
import { ALWAYS, NEVER, allOf, requireRole, unknownPlan } from "@typesys/core";
import { INVENTORY } from "@typesys/cold-chain";

export const RECALLS = "recall-exchange";
export const WORKFLOW = "coldchain.RespondToRecall";

/** Set while the workflow engine invokes an Action for a run: the response's writes happen only inside a signed-off run. */
export const insideRun = new AsyncLocalStorage();

const recallType = {
  schema: {
    $id: "https://typesys.dev/types/coldchain/Recall/1.0.0",
    title: "Recall",
    description: "A manufacturer's recall notice, in the recall exchange, with our response on file there.",
    type: "object",
    properties: {
      firm: { type: "string", description: "The issuing manufacturer." },
      product: { type: "string" },
      ndc: { type: "string", description: "The NDC as the exchange writes it: eleven digits, no hyphens." },
      recallClass: { type: "string", enum: ["I", "II", "III"] },
      lifecycle: { type: "string", enum: ["active", "terminated"] },
      embargoed: { type: "boolean", description: "True while the manufacturer has not made the notice public." },
      healthHazard: { type: "string", description: "The manufacturer's health hazard evaluation. Quality assurance only." },
      responseStatus: { type: "string", enum: ["awaiting", "responded"] },
      lotsHeld: { type: "array", items: { type: "string" }, description: "From the response on file: the lots we quarantined." },
      dosesHeld: { type: "integer", description: "From the response on file: the doses in those lots." },
      shipmentsInTransit: { type: "array", items: { type: "string" }, description: "From the response on file: shipments reported in transit." },
      signedOffBy: { type: "string", description: "From the response on file: who signed it off." },
      affectedLots: { type: "array", items: { type: "string" }, description: "Every lot number the notice recalls, held by us or not." },
      issuedOn: { type: "string", format: "date" }
    },
    required: ["firm", "product", "ndc"],
    "x-actions": { actions: ["QuarantineRecallLots", "ReleaseRecallLots", "FileRecallResponse"] },
    "x-policy": { objectPolicy: "coldchain.read-recall", propertyPolicies: { healthHazard: "coldchain.recall-hazard" } }
  },
  options: { name: "coldchain.Recall", version: "1.0.0" }
};

const action = (a) => ({ id: `action-coldchain-${a.name.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase()}`, version: "1.0.0", auditRequired: true, outputSchema: { type: "object" }, ...a });
const lotIds = { type: "array", items: { type: "string", minLength: 1 } };

export const recallManifest = {
  domain: "coldchain-recall",
  types: [recallType],
  actions: [
    action({
      name: "QuarantineRecallLots",
      description: "Quarantines the lots a signed-off recall response names in the pharmacy inventory, each with a hold reason naming the recall.",
      applicableTypes: ["coldchain.Recall"],
      target: { idFrom: "recallId" },
      inputSchema: { type: "object", properties: { recallId: { type: "string", minLength: 1 }, lotIds, reason: { type: "string", minLength: 1 } }, required: ["recallId", "lotIds", "reason"], additionalProperties: false },
      authorizationPolicy: "coldchain.recall-execute",
      implementation: { dataSourceId: INVENTORY, operation: "POST /api/lots/{lotId}/quarantine (each lot)" },
      sideEffects: "mutates",
      idempotency: "natural"
    }),
    action({
      name: "ReleaseRecallLots",
      description: "Undoes QuarantineRecallLots: releases the lots it held, and restores the hold of a lot that was already held.",
      applicableTypes: ["coldchain.Recall"],
      target: { idFrom: "recallId" },
      inputSchema: {
        type: "object",
        properties: {
          recallId: { type: "string", minLength: 1 },
          lots: { type: "array", items: { type: "object", properties: { lotId: { type: "string" }, priorStatus: { type: "string" }, priorReason: { type: ["string", "null"] } }, required: ["lotId", "priorStatus"] } }
        },
        required: ["recallId", "lots"],
        additionalProperties: false
      },
      authorizationPolicy: "coldchain.recall-execute",
      implementation: { dataSourceId: INVENTORY, operation: "POST /api/lots/{lotId}/release (each lot)" },
      sideEffects: "mutates",
      idempotency: "natural"
    }),
    action({
      name: "FileRecallResponse",
      description: "Files our effectiveness response to a notice with the recall exchange; once per notice.",
      applicableTypes: ["coldchain.Recall"],
      target: { idFrom: "recallId" },
      inputSchema: {
        type: "object",
        properties: {
          recallId: { type: "string", minLength: 1 },
          lotsQuarantined: lotIds,
          dosesQuarantined: { type: "integer", minimum: 0 },
          shipmentsInTransit: lotIds,
          signedOffBy: { type: "string", minLength: 1 }
        },
        required: ["recallId", "lotsQuarantined", "dosesQuarantined", "shipmentsInTransit", "signedOffBy"],
        additionalProperties: false
      },
      authorizationPolicy: "coldchain.recall-execute",
      implementation: { dataSourceId: RECALLS, operation: "POST /exchange/v1/notices/{recallId}/responses" },
      sideEffects: "external",
      idempotency: "none"
    })
  ],
  dataSources: [{ id: RECALLS, name: "Recall exchange (independent service, subscribed, not owned)", kind: "http" }],
  mappings: [{ id: "map-coldchain.Recall", typeName: "coldchain.Recall", target: "property", targetName: "*", dataSourceId: RECALLS, operation: "get", resolutionMode: "live" }]
};

/**
 * Reading a notice: quality assurance reads every one; a logistics
 * coordinator and the auditor read public ones only (an embargoed notice is
 * need-to-know for quality assurance); nobody else reads any.
 */
const readRecall = Object.assign(
  (request) => {
    const roles = request.subject.roles;
    if (roles.includes("qa")) return { allow: true };
    if (!roles.some((r) => r === "logistics" || r === "auditor")) return { allow: false, reason: "Requires one of roles [qa, logistics, auditor]" };
    const attrs = request.resource.attributes;
    if (!attrs) return { allow: false, reason: "Public notices only: decided per notice" };
    // No such notice: nothing to withhold, so the caller is told it does not exist, as quality assurance is.
    if (Object.keys(attrs).length === 0) return { allow: true };
    return attrs.embargoed === false ? { allow: true } : { allow: false, reason: "An embargoed notice is need-to-know for quality assurance alone" };
  },
  {
    plan: (request) => {
      const roles = request.subject.roles;
      if (roles.includes("qa")) return ALWAYS;
      if (!roles.some((r) => r === "logistics" || r === "auditor")) return NEVER;
      return unknownPlan([{ code: "opaque-rule", policyName: request.policyName }]);
    }
  }
);

/** Only inside a run of the workflow, after its sign-off: never invoked on its own. */
const withinRun = Object.assign(
  () => (insideRun.getStore() ? { allow: true } : { allow: false, reason: `Only a signed-off ${WORKFLOW} run makes a recall response's writes` }),
  { plan: () => (insideRun.getStore() ? ALWAYS : NEVER) }
);

export const recallPolicyRules = {
  "coldchain.read-recall": readRecall,
  /** The health hazard evaluation is confidential to quality assurance. */
  "coldchain.recall-hazard": requireRole("qa"),
  /** Who may ask to respond to a notice. */
  "coldchain.recall-respond": requireRole("logistics", "qa"),
  /** Who signs a response off: quality assurance (never the person who asked, which the engine enforces). */
  "coldchain.recall-signoff": requireRole("qa"),
  /** The writes a signed-off response makes, as the person who asked for it. */
  "coldchain.recall-execute": allOf(requireRole("logistics", "qa"), withinRun)
};

/** The exchange, read and written with our distributor client. */
export function recallAdapter(baseUrl, clientId = "coldchain-distributor", secret = "rx-exchange-2026") {
  return new HttpAdapter({
    dataSourceId: RECALLS,
    system: "Recall exchange",
    baseUrl,
    auth: { kind: "header", name: "authorization", value: `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}` },
    types: {
      "coldchain.Recall": {
        get: "/exchange/v1/notices/{id}",
        list: { path: "/exchange/v1/notices", items: "/data", pageSizeParam: "pageSize", pageSize: 50, params: { firm: "issuingFirm", ndc: "ndc11" } },
        id: "/recallNumber",
        fields: {
          firm: "/issuingFirm",
          product: "/product/name",
          ndc: "/product/ndc11",
          recallClass: { from: "/hazardClass", map: { CLASS_I: "I", CLASS_II: "II", CLASS_III: "III" } },
          lifecycle: { from: "/lifecycle", map: { ACTIVE: "active", TERMINATED: "terminated" } },
          embargoed: { from: "/disclosure", map: { EMBARGOED: true, PUBLIC: false } },
          healthHazard: "/hazardEvaluation",
          responseStatus: { from: "/responseState", map: { PENDING: "awaiting", RECEIVED: "responded" } },
          lotsHeld: "/response/lotsQuarantined",
          dosesHeld: "/response/dosesQuarantined",
          shipmentsInTransit: "/response/shipmentsInTransit",
          signedOffBy: "/response/signedOffBy",
          affectedLots: "/affectedLotCodes",
          issuedOn: "/issuedOn"
        }
      }
    },
    actions: {
      FileRecallResponse: { method: "POST", path: "/exchange/v1/notices/{recallId}/responses", body: ["lotsQuarantined", "dosesQuarantined", "shipmentsInTransit", "signedOffBy"] }
    },
    // The exchange wraps every answer in { data }, and lists affected lots as objects; the model holds their lot numbers.
    fetch: async (url, init) => {
      const res = await fetch(url, init);
      if (init?.method && init.method !== "GET") return res;
      if (!res.ok || !(res.headers.get("content-type") ?? "").includes("json")) return res;
      const body = await res.json();
      const shape = (n) => (n && typeof n === "object" && Array.isArray(n.affectedLots) ? { ...n, affectedLotCodes: n.affectedLots.map((l) => l?.lotCode).filter((c) => typeof c === "string") } : n);
      // A list keeps its { data, meta } envelope; one notice is the record itself.
      const out = Array.isArray(body?.data) ? { ...body, data: body.data.map(shape) } : shape(body?.data);
      return new Response(JSON.stringify(out ?? null), { status: res.status, headers: { "content-type": "application/json" } });
    }
  });
}

/**
 * The host's pharmacy inventory adapter, as it is, plus the two recall
 * Actions: each carried out lot by lot through the inventory's own
 * single-lot endpoints, on the key the host holds.
 */
export function withRecallActions(inventory) {
  const lotAction = (name) => ({ id: name, name, version: "1.0.0", description: name, applicableTypes: ["coldchain.Lot"], inputSchema: {}, outputSchema: {}, authorizationPolicy: "", implementation: { dataSourceId: INVENTORY, operation: name }, sideEffects: "mutates", idempotency: "natural", auditRequired: true, outputType: "coldchain.Lot" });
  const read = async (lotId, opts) => (await inventory.resolveProperties("coldchain.Lot", lotId, ["status", "holdReason"], opts)).values;
  return new Proxy(inventory, {
    get(target, prop, receiver) {
      if (prop !== "executeAction") return Reflect.get(target, prop, receiver);
      return async (def, input, ctx, opts) => {
        if (def.name === "QuarantineRecallLots") {
          const lots = [];
          for (const lotId of input.lotIds) {
            const before = await read(lotId, opts);
            if (before.status === undefined) throw new Error(`Lot ${lotId} is not in the pharmacy inventory`);
            if (before.status === "destroyed") throw new Error(`Lot ${lotId} was destroyed`);
            const priorReason = before.holdReason ?? null;
            if (before.status === "quarantined") {
              // Already held for another reason: held again, with a reason that also names this recall.
              if (typeof priorReason === "string" && priorReason.includes(input.recallId)) {
                lots.push({ lotId, priorStatus: "quarantined", priorReason, unchanged: true });
                continue;
              }
              await target.executeAction(lotAction("ReleaseLot"), { lotId }, ctx, opts);
              await target.executeAction(lotAction("QuarantineLot"), { lotId, reason: priorReason ? `${input.reason}; previously: ${priorReason}` : input.reason }, ctx, opts);
            } else {
              await target.executeAction(lotAction("QuarantineLot"), { lotId, reason: input.reason }, ctx, opts);
            }
            lots.push({ lotId, priorStatus: before.status, priorReason });
          }
          return { recallId: input.recallId, lots };
        }
        if (def.name === "ReleaseRecallLots") {
          const released = [];
          for (const l of input.lots) {
            if (l.unchanged) continue;
            await target.executeAction(lotAction("ReleaseLot"), { lotId: l.lotId }, ctx, opts);
            if (l.priorStatus === "quarantined") await target.executeAction(lotAction("QuarantineLot"), { lotId: l.lotId, reason: l.priorReason ?? "held" }, ctx, opts);
            released.push(l.lotId);
          }
          return { recallId: input.recallId, released };
        }
        return target.executeAction(def, input, ctx, opts);
      };
    }
  });
}
