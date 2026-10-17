import { HttpAdapter } from "@typesys/adapter-http";
import type { ActionContext, ActionDefinition, Adapter, AdapterCallOptions, DataSource, DomainManifest, Identity, Mapping, PolicyRequest, PolicyRule } from "@typesys/core";
import { allOf, anyOf, requireRole } from "@typesys/core";
import { INVENTORY } from "./model.js";
import { startService, type RunningService } from "./services.js";
import { buildColdChainHost, coldChainIdentities, resolveColdChainIdentity, type ColdChainHost, type ColdChainHostOptions } from "./setup.js";

/**
 * The recall exchange, a fourth system the distributor subscribes to but
 * does not own: manufacturers' recall notices, and the effectiveness
 * responses filed against them. Added to the cold chain model by
 * `buildRecallHost`, on the same runtime, beside the other three.
 */
export const RECALLS = "recall-exchange";

const reason = { type: "string", minLength: 1 } as const;
const lotIds = { type: "array", items: { type: "string", minLength: 1 }, uniqueItems: true } as const;

const action = (a: Omit<ActionDefinition, "id" | "version" | "auditRequired">): ActionDefinition => ({
  id: `action-coldchain-${a.name.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase()}`,
  version: "1.0.0",
  auditRequired: true,
  ...a
});

export const recallManifest: DomainManifest = {
  domain: "coldchain",
  types: [
    {
      schema: {
        $id: "https://typesys.dev/types/coldchain/Recall/1.0.0",
        title: "Recall",
        description: "A manufacturer's recall notice, in the recall exchange, and the response on file against it.",
        type: "object",
        properties: {
          firm: { type: "string", description: "The issuing manufacturer." },
          product: { type: "string" },
          ndc: { type: "string", pattern: "^[0-9]{11}$", description: "National Drug Code, eleven digits, as the exchange writes it." },
          recallClass: { type: "string", enum: ["I", "II", "III"] },
          lifecycle: { type: "string", enum: ["active", "terminated"] },
          embargoed: { type: "boolean", description: "True while the manufacturer has not made the notice public: need-to-know for quality assurance." },
          healthHazard: { type: "string", description: "The manufacturer's health hazard evaluation. CONFIDENTIAL; quality assurance only." },
          issuedOn: { type: "string", format: "date" },
          affectedLots: {
            type: "array",
            description: "Every lot the manufacturer recalled, including lots we never held.",
            items: { type: "object", properties: { lotCode: { type: "string" }, expiry: { type: "string", format: "date" } }, required: ["lotCode"] }
          },
          responseStatus: { type: "string", enum: ["awaiting", "responded"] },
          lotsHeld: { type: "array", items: { type: "string" }, description: "From the response on file: the lots quarantined." },
          dosesHeld: { type: "integer", description: "From the response on file: the doses in those lots." },
          shipmentsInTransit: { type: "array", items: { type: "string" }, description: "From the response on file: shipments reported in transit." },
          signedOffBy: { type: "string", description: "From the response on file: who signed it off." }
        },
        required: ["firm", "product", "ndc", "recallClass", "lifecycle", "embargoed", "responseStatus"],
        "x-actions": { actions: ["FileRecallResponse"] },
        "x-policy": { objectPolicy: "coldchain.read-recall", propertyPolicies: { healthHazard: "coldchain.qa" } },
        // Enforced beside the policy: only a subject cleared CONFIDENTIAL reads it, whatever a policy admits (ADR-0032).
        "x-provenance": { properties: { healthHazard: { classification: "CONFIDENTIAL" } } }
      } as DomainManifest["types"][number]["schema"],
      options: { name: "coldchain.Recall", version: "1.0.0" }
    }
  ],
  actions: [
    action({
      name: "HoldLotsForRecall",
      description: "Quarantines each listed lot in the pharmacy inventory with a hold reason naming the recall. All or none: a lot that cannot be held releases those already held.",
      applicableTypes: ["coldchain.Lot"],
      inputSchema: { type: "object", properties: { recallId: reason, lotIds }, required: ["recallId", "lotIds"], additionalProperties: false },
      outputSchema: { type: "object", properties: { recallId: { type: "string" }, held: { type: "array", items: { type: "string" } } }, required: ["recallId", "held"] },
      authorizationPolicy: "coldchain.respond-recall",
      requiresApproval: true,
      implementation: { dataSourceId: INVENTORY, operation: "POST /api/lots/{lotId}/quarantine, per lot" },
      sideEffects: "mutates",
      idempotency: "natural"
    }),
    action({
      name: "ReleaseRecallHolds",
      description: "Releases lots a recall hold quarantined: undoes HoldLotsForRecall.",
      applicableTypes: ["coldchain.Lot"],
      inputSchema: { type: "object", properties: { lotIds }, required: ["lotIds"], additionalProperties: false },
      outputSchema: { type: "object", properties: { released: { type: "array", items: { type: "string" } } }, required: ["released"] },
      authorizationPolicy: "coldchain.respond-recall",
      requiresApproval: true,
      implementation: { dataSourceId: INVENTORY, operation: "POST /api/lots/{lotId}/release, per lot" },
      sideEffects: "mutates",
      idempotency: "natural"
    }),
    action({
      name: "FileRecallResponse",
      description: "Files the distributor's effectiveness response to a recall with the exchange. The exchange refuses a terminated notice, one already answered, and a lot not on the notice.",
      applicableTypes: ["coldchain.Recall"],
      target: { idFrom: "recallNumber" },
      inputSchema: {
        type: "object",
        properties: {
          recallNumber: reason,
          lotsQuarantined: { type: "array", items: { type: "string" } },
          dosesQuarantined: { type: "integer", minimum: 0 },
          shipmentsInTransit: { type: "array", items: { type: "string" } },
          signedOffBy: reason
        },
        required: ["recallNumber", "lotsQuarantined", "dosesQuarantined", "shipmentsInTransit", "signedOffBy"],
        additionalProperties: false
      },
      outputSchema: { type: "object" },
      authorizationPolicy: "coldchain.respond-recall",
      requiresApproval: true,
      implementation: { dataSourceId: RECALLS, operation: "POST /exchange/v1/notices/{recallNumber}/responses" },
      sideEffects: "external",
      idempotency: "none"
    })
  ],
  dataSources: [{ id: RECALLS, name: "Recall exchange (industry service)", kind: "http" }] satisfies DataSource[],
  mappings: [{ id: "map-coldchain.Recall", typeName: "coldchain.Recall", target: "property", targetName: "*", dataSourceId: RECALLS, operation: "get", resolutionMode: "live" }] satisfies Mapping[]
};

const MODEL = "coldchain-model";

/**
 * Who reads a notice: quality assurance every one; the coordinator, the
 * auditor and the enclave's model only those the manufacturer has made
 * public. Built from the combinators, so a carrier, whom no branch admits,
 * is refused a query outright rather than shown an empty list (ADR-0038).
 */
const publicNotice: PolicyRule = ({ resource }: PolicyRequest) =>
  // Asked about the Type rather than one notice: some notices are public.
  !resource.attributes || resource.attributes.embargoed === false ? { allow: true } : { allow: false, reason: "A notice under embargo is need-to-know for quality assurance alone" };
const readRecall = anyOf(requireRole("qa"), allOf(requireRole("logistics", "auditor", MODEL), publicNotice));

export const recallPolicyRules: Record<string, PolicyRule> = {
  "coldchain.read-recall": readRecall,
  /** Who may ask to respond to a notice, and carry out the response once it is signed off. */
  "coldchain.respond-recall": requireRole("logistics", "qa")
};

/** The exchange, read and written as the distributor's client (HTTP Basic), its `{ data, meta }` envelope and numbered pages unwrapped. */
export function recallExchangeAdapter(baseUrl: string, client = { id: "coldchain-distributor", secret: "rx-exchange-2026" }): HttpAdapter {
  return new HttpAdapter({
    dataSourceId: RECALLS,
    system: "Recall exchange",
    baseUrl,
    auth: { kind: "header", name: "authorization", value: `Basic ${Buffer.from(`${client.id}:${client.secret}`).toString("base64")}` },
    types: {
      "coldchain.Recall": {
        get: "/exchange/v1/notices/{id}",
        record: "/data",
        list: { path: "/exchange/v1/notices", items: "/data", pages: { param: "page", more: "/meta/hasMore" } },
        id: "/recallNumber",
        fields: {
          firm: "/issuingFirm",
          product: "/product/name",
          ndc: "/product/ndc11",
          recallClass: { from: "/hazardClass", map: { CLASS_I: "I", CLASS_II: "II", CLASS_III: "III" } },
          lifecycle: { from: "/lifecycle", map: { ACTIVE: "active", TERMINATED: "terminated" } },
          embargoed: { from: "/disclosure", map: { PUBLIC: false, EMBARGOED: true } },
          healthHazard: "/hazardEvaluation",
          issuedOn: "/issuedOn",
          affectedLots: "/affectedLots",
          responseStatus: { from: "/responseState", map: { PENDING: "awaiting", RECEIVED: "responded" } },
          lotsHeld: "/response/lotsQuarantined",
          dosesHeld: "/response/dosesQuarantined",
          shipmentsInTransit: "/response/shipmentsInTransit",
          signedOffBy: "/response/signedOffBy"
        }
      }
    },
    actions: {
      FileRecallResponse: { method: "POST", path: "/exchange/v1/notices/{recallNumber}/responses", body: ["lotsQuarantined", "dosesQuarantined", "shipmentsInTransit", "signedOffBy"] }
    }
  });
}

/**
 * The pharmacy inventory, with the recall's two batch Actions: each is one
 * request per lot through the inventory's own QuarantineLot and ReleaseLot
 * requests, on the key the host holds. A hold that fails part way releases
 * what it held, so a refused lot never leaves the others quarantined.
 */
export function withRecallHolds(inventory: Adapter): Adapter {
  const one = (name: string, base: ActionDefinition): ActionDefinition => ({ ...base, name, outputType: undefined });
  const holdOne = (base: ActionDefinition, lotId: string, why: string, ctx: ActionContext, opts?: AdapterCallOptions) => inventory.executeAction(one("QuarantineLot", base), { lotId, reason: why }, ctx, opts);
  const releaseOne = (base: ActionDefinition, lotId: string, ctx: ActionContext, opts?: AdapterCallOptions) => inventory.executeAction(one("ReleaseLot", base), { lotId }, ctx, opts);
  return {
    dataSourceId: inventory.dataSourceId,
    resolveProperties: (...a) => inventory.resolveProperties(...a),
    queryByType: (...a) => inventory.queryByType(...a),
    resolveRelationship: (...a) => inventory.resolveRelationship(...a),
    ...(inventory.aggregate ? { aggregate: (...a: Parameters<NonNullable<Adapter["aggregate"]>>) => inventory.aggregate!(...a) } : {}),
    ...(inventory.sensitiveFields ? { sensitiveFields: (t: string) => inventory.sensitiveFields!(t) } : {}),
    ...(inventory.canFilter ? { canFilter: (...a: Parameters<NonNullable<Adapter["canFilter"]>>) => inventory.canFilter!(...a) } : {}),
    async executeAction(action, input, ctx, opts) {
      const i = input as { recallId?: string; lotIds?: string[] };
      if (action.name === "HoldLotsForRecall") {
        const held: string[] = [];
        try {
          for (const lotId of i.lotIds ?? []) {
            // A lot already quarantined stays as it is, and is not this hold's to release.
            const { values } = await inventory.resolveProperties("coldchain.Lot", lotId, ["status"], opts);
            if (values.status === "quarantined") continue;
            await holdOne(action, lotId, `Recall ${i.recallId}: quarantined pending the manufacturer's recall`, ctx, opts);
            held.push(lotId);
          }
        } catch (err) {
          for (const lotId of held.reverse()) await releaseOne(action, lotId, ctx, opts).catch(() => undefined);
          throw err;
        }
        return { recallId: i.recallId, held };
      }
      if (action.name === "ReleaseRecallHolds") {
        for (const lotId of i.lotIds ?? []) await releaseOne(action, lotId, ctx, opts);
        return { released: [...(i.lotIds ?? [])] };
      }
      return inventory.executeAction(action, input, ctx, opts);
    }
  };
}

export interface RecallHostOptions extends Omit<ColdChainHostOptions, "extend"> {
  /** The exchange's base URL. When omitted, `TYPESYS_COLDCHAIN_RECALLS_URL`; when that is unset too, a copy is started here. */
  readonly exchangeUrl?: string;
}

export type RecallHost = ColdChainHost & { exchange?: RunningService };

/** The cold chain host with the recall exchange added: one runtime, four systems. */
export async function buildRecallHost(options: RecallHostOptions = {}): Promise<RecallHost> {
  const given = options.exchangeUrl ?? process.env.TYPESYS_COLDCHAIN_RECALLS_URL;
  const exchange = given ? undefined : await startService("recall-exchange");
  const url = given ?? exchange!.url;
  const kill = () => exchange?.process.kill();
  if (exchange) process.once("exit", kill);
  const host = await buildColdChainHost({
    ...options,
    extend: { manifests: [recallManifest], policyRules: recallPolicyRules, adapters: (base) => [recallExchangeAdapter(url), withRecallHolds(base[INVENTORY]!)] }
  });
  if (!exchange) return host;
  const stopOthers = host.services?.stop;
  return {
    ...host,
    exchange,
    // The compiler and the tests stop a host's services when they are done with it.
    services: {
      ...(host.services ?? ({} as NonNullable<ColdChainHost["services"]>)),
      stop: async () => {
        process.off("exit", kill);
        await Promise.all([stopOthers?.(), exchange.stop()]);
      }
    }
  };
}

/** A second quality assurance pharmacist, so one can sign off what the other asked for. */
export const recallIdentities: Record<"qa2", Identity> = {
  qa2: { subjectId: "user-qa-2", roles: ["qa"], attributes: { displayName: "Dr. Tomasz Brandt" }, clearance: "CONFIDENTIAL" }
};

/** The cold chain's demonstration tokens, and `demo-qa2-token` for Dr. Brandt. */
export function resolveRecallIdentity(token: string | null | undefined): Promise<Identity> {
  return token === "demo-qa2-token" ? Promise.resolve(recallIdentities.qa2) : resolveColdChainIdentity(token);
}

export const recallPeople = { ...coldChainIdentities, ...recallIdentities };
