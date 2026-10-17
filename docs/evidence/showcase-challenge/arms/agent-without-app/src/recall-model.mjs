// The recall exchange as part of the governed model: the Type coldchain.Recall,
// its adapter over the exchange (HTTP Basic, page-numbered paging), the Action
// that files a response, and the rules that decide who reads what of a notice.
import { HttpAdapter } from "@typesys/adapter-http";
import { allOf, anyOf, requireRole } from "@typesys/core";

export const RECALLS = "recall-exchange";

/** The role the workflow's own service identity holds: it alone reads a notice's lot list. */
export const WORKFLOW_ROLE = "recall-workflow";

/** The workflow's service identity, used only to read the lots a notice lists. */
export const workflowIdentity = Object.freeze({
  subjectId: "svc-recall-response",
  roles: [WORKFLOW_ROLE],
  attributes: { displayName: "Recall response workflow" },
  clearance: "INTERNAL"
});

const RECALL_SCHEMA = {
  $id: "https://typesys.dev/types/coldchain/Recall/1.0.0",
  title: "Recall",
  description: "A manufacturer's recall notice, in the recall exchange, with the response this distributor filed for it.",
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
    lotsHeld: { type: "array", items: { type: "string" } },
    dosesHeld: { type: "integer" },
    shipmentsInTransit: { type: "array", items: { type: "string" } },
    signedOffBy: { type: "string" },
    affectedLots: {
      type: "array",
      description: "Every lot the notice lists, held by us or not. Read by the workflow only.",
      items: { type: "object", properties: { lotCode: { type: "string" }, expiry: { type: "string" } } }
    }
  },
  required: ["firm", "product", "ndc", "lifecycle", "responseStatus"],
  "x-actions": { actions: ["FileRecallResponse"] },
  "x-policy": {
    objectPolicy: "coldchain.read-recall",
    propertyPolicies: { healthHazard: "coldchain.recall-hazard", affectedLots: "coldchain.recall-lots" }
  }
};

export const recallManifest = {
  domain: "coldchain-recall",
  types: [{ schema: RECALL_SCHEMA, options: { name: "coldchain.Recall", version: "1.0.0" } }],
  actions: [
    {
      id: "action-coldchain-file-recall-response",
      name: "FileRecallResponse",
      version: "1.0.0",
      description: "Files this distributor's effectiveness response to a recall notice with the recall exchange.",
      applicableTypes: ["coldchain.Recall"],
      target: { idFrom: "recallId" },
      inputSchema: {
        type: "object",
        properties: {
          recallId: { type: "string" },
          lotsQuarantined: { type: "array", items: { type: "string" } },
          dosesQuarantined: { type: "integer", minimum: 0 },
          shipmentsInTransit: { type: "array", items: { type: "string" } },
          signedOffBy: { type: "string", minLength: 1 }
        },
        required: ["recallId", "lotsQuarantined", "dosesQuarantined", "shipmentsInTransit", "signedOffBy"],
        additionalProperties: false
      },
      outputSchema: { type: "object" },
      authorizationPolicy: "coldchain.recall-file",
      implementation: { dataSourceId: RECALLS, operation: "POST /exchange/v1/notices/{recallId}/responses" },
      sideEffects: "external",
      idempotency: "none",
      auditRequired: true
    }
  ],
  dataSources: [{ id: RECALLS, name: "Recall exchange (independent service)", kind: "http" }],
  mappings: [{ id: "map-coldchain.Recall", typeName: "coldchain.Recall", target: "property", targetName: "*", dataSourceId: RECALLS, operation: "get", resolutionMode: "live" }]
};

/** Decided on the notice's own values: a public notice. A type-level request (no values) is not decided here. */
const notEmbargoed = (request) => {
  const a = request.resource.attributes;
  if (!a) return { allow: false, reason: "Decided per notice: an embargoed notice is need-to-know for quality assurance" };
  return a.embargoed === true ? { allow: false, reason: "The notice is under embargo: need-to-know for quality assurance" } : { allow: true };
};

export const recallPolicyRules = {
  /** Quality assurance reads every notice; the coordinator and the auditor read public ones; a carrier none. */
  "coldchain.read-recall": anyOf(requireRole("qa", WORKFLOW_ROLE), allOf(requireRole("logistics", "auditor"), notEmbargoed)),
  /** The health hazard evaluation is confidential to quality assurance. */
  "coldchain.recall-hazard": requireRole("qa"),
  /** The lot list is read by the workflow, not shown to people (it is not part of the notice as people read it). */
  "coldchain.recall-lots": requireRole(WORKFLOW_ROLE),
  /** Filing a response is done by quality assurance's sign-off. */
  "coldchain.recall-file": requireRole("qa"),
  /** Who may ask to respond to a notice. */
  "coldchain.recall-respond": requireRole("logistics", "qa"),
  /** Who may sign a response off (never the person who asked, which the workflow decides). */
  "coldchain.recall-signoff": requireRole("qa")
};

/**
 * The exchange pages by page number, two a page, saying only `hasMore`. The
 * adapter reads one list response, so every page is gathered into one here;
 * and one notice, which comes wrapped in `{ data }`, is unwrapped.
 */
function pagingFetch(baseFetch) {
  return async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "GET" && /^\/exchange\/v1\/notices\/[^/]+$/.test(url.pathname)) {
      // One notice comes as { data: notice }: the adapter maps the notice itself.
      const res = await baseFetch(input, init);
      if (!res.ok) return res;
      const body = await res.json();
      return new Response(JSON.stringify(body?.data ?? null), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (method !== "GET" || url.pathname !== "/exchange/v1/notices") return baseFetch(input, init);
    const data = [];
    for (let page = 1; page <= 100; page++) {
      url.searchParams.set("page", String(page));
      url.searchParams.set("pageSize", "50");
      const res = await baseFetch(url.href, init);
      if (!res.ok) return res;
      const body = await res.json();
      if (!Array.isArray(body?.data)) return new Response(JSON.stringify(body), { status: res.status, headers: { "content-type": "application/json" } });
      data.push(...body.data);
      if (!body.meta?.hasMore) break;
    }
    return new Response(JSON.stringify({ data, meta: { page: 1, pageSize: data.length, total: data.length, hasMore: false } }), { status: 200, headers: { "content-type": "application/json" } });
  };
}

/** The exchange as the distributor client: it reads every notice and files responses. */
export function recallAdapter(baseUrl, clientId = "coldchain-distributor", secret = "rx-exchange-2026") {
  return new HttpAdapter({
    dataSourceId: RECALLS,
    system: "Recall exchange",
    baseUrl,
    auth: { kind: "header", name: "authorization", value: `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}` },
    fetch: pagingFetch(globalThis.fetch.bind(globalThis)),
    types: {
      "coldchain.Recall": {
        get: "/exchange/v1/notices/{id}",
        list: { path: "/exchange/v1/notices", items: "/data" },
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
          affectedLots: "/affectedLots"
        }
      }
    },
    actions: {
      FileRecallResponse: { method: "POST", path: "/exchange/v1/notices/{recallId}/responses", body: ["lotsQuarantined", "dosesQuarantined", "shipmentsInTransit", "signedOffBy"] }
    }
  });
}
