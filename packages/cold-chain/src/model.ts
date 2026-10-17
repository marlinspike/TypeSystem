import type { ActionDefinition, DataSource, DomainManifest, JsonSchema2020, Mapping } from "@typesys/core";
import { allOf, anyOf, linearClassification, requireAttributeMatch, requireRole, type PolicyRule } from "@typesys/core";

export const TRACKER = "shipment-tracker";
export const SENSORS = "sensor-hub";
export const INVENTORY = "pharmacy-inventory";

/** Commercial markings, lowest first: a lot's unit cost is CONFIDENTIAL contract pricing. */
export const coldChainClassification = linearClassification(["PUBLIC", "INTERNAL", "CONFIDENTIAL"], "coldchain-commercial");

const type = (name: string, schema: JsonSchema2020) => ({ schema: { $id: `https://typesys.dev/types/coldchain/${name}/1.0.0`, title: name, ...schema }, options: { name: `coldchain.${name}`, version: "1.0.0" } });

/**
 * The model a cold-chain team reads: one vocabulary over three services
 * that share none. A shipment lives in the tracker, its temperature in the
 * sensor hub, its lots in the pharmacy inventory; the relationships cross
 * them and are `optional` (ADR-0072), so a failing service costs a part of
 * the answer, said as such, never the whole.
 */
export const coldChainManifest: DomainManifest = {
  domain: "coldchain",
  types: [
    type("Site", {
      description: "A distribution center, hospital pharmacy or clinic, in the pharmacy inventory.",
      type: "object",
      properties: {
        name: { type: "string" },
        kind: { type: "string", enum: ["distribution", "hospital", "clinic"] },
        city: { type: "string" },
        lat: { type: "number" },
        lon: { type: "number" }
      },
      required: ["name"],
      "x-relationships": {
        lots: { target: "coldchain.Lot", cardinality: "one-to-many", description: "Lots held at or bound for this site.", resolution: { dataSourceId: INVENTORY, operation: "byForeignKey:siteId" }, optional: true }
      },
      "x-policy": { objectPolicy: "coldchain.read-site" }
    }),
    type("Shipment", {
      description: "A refrigerated consignment, in the shipment tracker.",
      type: "object",
      properties: {
        origin: { type: "string", description: "The site it left." },
        destination: { type: "string", description: "The site it is bound for." },
        carrier: { type: "string" },
        status: { type: "string", enum: ["in-transit", "delivered", "held"] },
        lat: { type: "number", description: "Its last GPS fix." },
        lon: { type: "number" },
        departedAt: { type: "string", format: "date-time" },
        eta: { type: "string", format: "date-time" }
      },
      required: ["origin", "destination", "status"],
      "x-relationships": {
        readings: { target: "coldchain.Reading", cardinality: "one-to-many", description: "Its logger's temperature readings, from the sensor hub.", resolution: { dataSourceId: SENSORS, operation: "byForeignKey:shipmentId" }, optional: true },
        excursions: { target: "coldchain.Excursion", cardinality: "one-to-many", description: "Times its temperature left the permitted range, from the sensor hub.", resolution: { dataSourceId: SENSORS, operation: "byForeignKey:shipmentId" }, optional: true },
        lots: { target: "coldchain.Lot", cardinality: "one-to-many", description: "The lots it carries, from the pharmacy inventory.", resolution: { dataSourceId: INVENTORY, operation: "byForeignKey:shipmentId" }, optional: true }
      },
      "x-actions": { actions: ["QuarantineShipmentLots", "ReleaseShipmentLots"] },
      "x-policy": { objectPolicy: "coldchain.read-shipment" }
    }),
    type("Reading", {
      description: "One temperature reading from a shipment's logger, in the sensor hub.",
      type: "object",
      properties: {
        shipmentId: { type: "string" },
        logger: { type: "string" },
        at: { type: "string", format: "date-time" },
        temperatureC: { type: "number" }
      },
      required: ["shipmentId", "at", "temperatureC"],
      "x-policy": { objectPolicy: "coldchain.telemetry" }
    }),
    type("Excursion", {
      description: "A time a shipment's temperature left 2–8 °C, in the sensor hub.",
      type: "object",
      properties: {
        shipmentId: { type: "string" },
        logger: { type: "string" },
        startedAt: { type: "string", format: "date-time" },
        endedAt: { type: "string", format: "date-time" },
        peakC: { type: "number", description: "The reading furthest from the range." },
        minutesOut: { type: "integer" },
        severity: { type: "string", enum: ["minor", "major", "critical"] },
        status: { type: "string", enum: ["open", "closed"] },
        disposition: { type: ["string", "null"], enum: ["release", "quarantine", "destroy", null] },
        note: { type: ["string", "null"] }
      },
      required: ["shipmentId", "severity", "status"],
      "x-actions": { actions: ["CloseExcursion", "ReopenExcursion"] },
      "x-policy": { objectPolicy: "coldchain.telemetry" }
    }),
    type("Lot", {
      description: "A manufacturer's lot of a cold-chain product, in the pharmacy inventory.",
      type: "object",
      properties: {
        product: { type: "string" },
        ndc: { type: "string", description: "National Drug Code." },
        manufacturer: { type: "string" },
        doses: { type: "integer" },
        unitCost: { type: "number", description: "Contract price per dose, USD. CONFIDENTIAL." },
        status: { type: "string", enum: ["available", "in-transit", "quarantined", "destroyed"] },
        expiresOn: { type: "string", format: "date" },
        siteId: { type: "string" },
        shipmentId: { type: "string" },
        minTempC: { type: "number" },
        maxTempC: { type: "number" },
        holdReason: { type: ["string", "null"] }
      },
      required: ["product", "status"],
      "x-actions": { actions: ["QuarantineLot", "ReleaseLot"] },
      "x-policy": { objectPolicy: "coldchain.inventory" },
      // Enforced beside the policy, never through it: only a subject cleared CONFIDENTIAL reads it (ADR-0032).
      "x-provenance": { properties: { unitCost: { classification: "CONFIDENTIAL" } } }
    })
  ],
  actions: coldChainActions(),
  dataSources: [
    { id: TRACKER, name: "Shipment tracker (independent service)", kind: "http" },
    { id: SENSORS, name: "Sensor hub (independent service)", kind: "http" },
    { id: INVENTORY, name: "Pharmacy inventory (independent service)", kind: "http" }
  ] satisfies DataSource[],
  mappings: (
    [
      ["coldchain.Site", INVENTORY],
      ["coldchain.Shipment", TRACKER],
      ["coldchain.Reading", SENSORS],
      ["coldchain.Excursion", SENSORS],
      ["coldchain.Lot", INVENTORY]
    ] as const
  ).map(([typeName, dataSourceId]): Mapping => ({ id: `map-${typeName}`, typeName, target: "property", targetName: "*", dataSourceId, operation: "get", resolutionMode: "live" }))
};

function coldChainActions(): ActionDefinition[] {
  const action = (a: Omit<ActionDefinition, "id" | "version" | "auditRequired" | "outputSchema"> & { outputSchema?: JsonSchema2020 }): ActionDefinition => ({
    id: `action-coldchain-${a.name.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase()}`,
    version: "1.0.0",
    auditRequired: true,
    outputSchema: { type: "object" },
    ...a
  });
  const reason = { type: "string", minLength: 1 };
  return [
    action({
      name: "CloseExcursion",
      description: "Records the disposition of a temperature excursion in the sensor hub, closing it.",
      applicableTypes: ["coldchain.Excursion"],
      target: { idFrom: "excursionId" },
      inputSchema: { type: "object", properties: { excursionId: { type: "string" }, disposition: { type: "string", enum: ["release", "quarantine", "destroy"] }, note: { type: "string" } }, required: ["excursionId", "disposition"], additionalProperties: false },
      outputType: "coldchain.Excursion",
      authorizationPolicy: "coldchain.dispose",
      implementation: { dataSourceId: SENSORS, operation: "POST /v1/excursions/{excursionId}/disposition" },
      sideEffects: "mutates",
      idempotency: "none"
    }),
    action({
      name: "ReopenExcursion",
      description: "Reopens a closed excursion: undoes a disposition recorded in error.",
      applicableTypes: ["coldchain.Excursion"],
      target: { idFrom: "excursionId" },
      inputSchema: { type: "object", properties: { excursionId: { type: "string" } }, required: ["excursionId"], additionalProperties: false },
      outputType: "coldchain.Excursion",
      authorizationPolicy: "coldchain.dispose",
      implementation: { dataSourceId: SENSORS, operation: "POST /v1/excursions/{excursionId}/reopen" },
      sideEffects: "mutates",
      idempotency: "natural"
    }),
    action({
      name: "QuarantineShipmentLots",
      description: "Holds every lot a shipment carries in the pharmacy inventory, so none is dispensed.",
      applicableTypes: ["coldchain.Shipment"],
      target: { idFrom: "shipmentId" },
      inputSchema: { type: "object", properties: { shipmentId: { type: "string" }, reason }, required: ["shipmentId", "reason"], additionalProperties: false },
      authorizationPolicy: "coldchain.dispose",
      implementation: { dataSourceId: INVENTORY, operation: "POST /api/shipments/{shipmentId}/quarantine" },
      sideEffects: "mutates",
      idempotency: "natural"
    }),
    action({
      name: "ReleaseShipmentLots",
      description: "Releases a shipment's quarantined lots to the status they had before.",
      applicableTypes: ["coldchain.Shipment"],
      target: { idFrom: "shipmentId" },
      inputSchema: { type: "object", properties: { shipmentId: { type: "string" } }, required: ["shipmentId"], additionalProperties: false },
      authorizationPolicy: "coldchain.dispose",
      implementation: { dataSourceId: INVENTORY, operation: "POST /api/shipments/{shipmentId}/release" },
      sideEffects: "mutates",
      idempotency: "natural"
    }),
    action({
      name: "QuarantineLot",
      description: "Holds one lot in the pharmacy inventory.",
      applicableTypes: ["coldchain.Lot"],
      target: { idFrom: "lotId" },
      inputSchema: { type: "object", properties: { lotId: { type: "string" }, reason }, required: ["lotId", "reason"], additionalProperties: false },
      outputType: "coldchain.Lot",
      authorizationPolicy: "coldchain.qa",
      implementation: { dataSourceId: INVENTORY, operation: "POST /api/lots/{lotId}/quarantine" },
      sideEffects: "mutates",
      idempotency: "natural"
    }),
    action({
      name: "ReleaseLot",
      description: "Releases one quarantined lot.",
      applicableTypes: ["coldchain.Lot"],
      target: { idFrom: "lotId" },
      inputSchema: { type: "object", properties: { lotId: { type: "string" } }, required: ["lotId"], additionalProperties: false },
      outputType: "coldchain.Lot",
      authorizationPolicy: "coldchain.qa",
      implementation: { dataSourceId: INVENTORY, operation: "POST /api/lots/{lotId}/release" },
      sideEffects: "mutates",
      idempotency: "natural"
    })
  ];
}

const MODEL = "coldchain-model";

/**
 * TypeSystem's own rules. Each service also enforces its own, on the
 * credential TypeSystem holds for it: a read or write must pass both.
 */
export const coldChainPolicyRules: Record<string, PolicyRule> = {
  /** A carrier's dispatcher sees only their own freight; the team sees all of it. */
  "coldchain.read-shipment": anyOf(requireRole("logistics", "qa", "auditor", MODEL), allOf(requireRole("carrier"), requireAttributeMatch("carrier", "carrier"))),
  "coldchain.read-site": requireRole("logistics", "qa", "auditor", "carrier", MODEL),
  "coldchain.telemetry": requireRole("logistics", "qa", "auditor", MODEL),
  "coldchain.inventory": requireRole("logistics", "qa", "auditor", MODEL),
  /** Who may start a disposition, and carry out the writes it makes. */
  "coldchain.dispose": requireRole("logistics", "qa"),
  /** Who may sign off a disposition: quality assurance, never the coordinator who asked for it. */
  "coldchain.qa-release": requireRole("qa"),
  "coldchain.qa": requireRole("qa"),
  /** Who may inspect the enforcement structure and explain anyone's access (ADR-0088): quality assurance and the auditor. */
  "coldchain.inspect": requireRole("qa", "auditor")
};
