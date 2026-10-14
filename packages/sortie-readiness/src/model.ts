import type { DataSource, DomainManifest, Mapping } from "@typesys/core";
import { allOf, requireAttributeMatch, requireRole, type PolicyRule } from "@typesys/core";

export const FLEET = "fleet-registry";
export const DEPOT = "parts-depot";
export const ROSTER = "crew-roster";

/**
 * The model a sortie planner reads: one vocabulary over three services that
 * share none. Each Type lives in one service; the relationships cross them,
 * and are `optional` (ADR-0072): when a service fails, the aircraft still
 * comes back, saying which part is missing and why.
 */
export const opsManifest: DomainManifest = {
  domain: "ops",
  types: [
    {
      schema: {
        $id: "https://typesys.dev/types/ops/Aircraft/1.0.0",
        title: "Aircraft",
        description: "An airframe in the fleet registry.",
        type: "object",
        properties: {
          tailNumber: { type: "string" },
          mds: { type: "string", description: "Mission design series, e.g. F-16C." },
          unit: { type: "string" },
          base: { type: "string", description: "ICAO code of its home base." },
          missionCapability: { type: "string", enum: ["full", "partial", "none"] },
          updatedAt: { type: "string", format: "date-time" }
        },
        required: ["tailNumber", "mds"],
        "x-relationships": {
          crew: {
            target: "ops.CrewMember",
            cardinality: "one-to-many",
            description: "Aircrew assigned to this airframe, from the crew roster.",
            resolution: { dataSourceId: ROSTER, operation: "byForeignKey:assignedTail" },
            optional: true
          },
          requisitions: {
            target: "ops.Requisition",
            cardinality: "one-to-many",
            description: "Parts requisitioned for this airframe, from the parts depot.",
            resolution: { dataSourceId: DEPOT, operation: "byForeignKey:tailNumber" },
            optional: true
          }
        },
        "x-policy": { objectPolicy: "ops.read", propertyPolicies: { missionCapability: "ops.maintenance" } }
      },
      options: { name: "ops.Aircraft", version: "1.0.0" }
    },
    {
      schema: {
        $id: "https://typesys.dev/types/ops/Requisition/1.0.0",
        title: "Requisition",
        description: "A part ordered for an airframe, in the parts depot.",
        type: "object",
        properties: {
          tailNumber: { type: "string" },
          nsn: { type: "string", description: "NATO stock number." },
          nomenclature: { type: "string" },
          base: { type: "string" },
          quantity: { type: "integer" },
          status: { type: "string", enum: ["awaiting", "in-transit", "issued"] },
          estimatedDelivery: { type: "string", format: "date" }
        },
        required: ["tailNumber", "nsn"],
        "x-policy": { objectPolicy: "ops.maintenance" }
      },
      options: { name: "ops.Requisition", version: "1.0.0" }
    },
    {
      schema: {
        $id: "https://typesys.dev/types/ops/CrewMember/1.0.0",
        title: "CrewMember",
        description: "An aircrew member in the crew roster.",
        type: "object",
        properties: {
          callsign: { type: "string" },
          name: { type: "string", description: "Personal data: planners only, and only when the roster releases it." },
          qualifications: { type: "array", items: { type: "string" } },
          unit: { type: "string" },
          assignedTail: { type: "string" },
          available: { type: "boolean" }
        },
        required: ["callsign"],
        "x-policy": { objectPolicy: "ops.crew", propertyPolicies: { name: "ops.planner" } }
      },
      options: { name: "ops.CrewMember", version: "1.0.0" }
    }
  ],
  actions: [],
  dataSources: [
    { id: FLEET, name: "Fleet registry (independent service)", kind: "http" },
    { id: DEPOT, name: "Parts depot (independent service)", kind: "http" },
    { id: ROSTER, name: "Crew roster (independent service)", kind: "http" }
  ] satisfies DataSource[],
  mappings: (
    [
      ["ops.Aircraft", FLEET],
      ["ops.Requisition", DEPOT],
      ["ops.CrewMember", ROSTER]
    ] as const
  ).map(([typeName, dataSourceId]): Mapping => ({ id: `map-${typeName}`, typeName, target: "property", targetName: "*", dataSourceId, operation: "get", resolutionMode: "live" }))
};

/**
 * TypeSystem's own rules. Each service also enforces its own, on the
 * credential TypeSystem holds for it: a read must pass both.
 */
export const opsPolicyRules: Record<string, PolicyRule> = {
  "ops.read": requireRole("planner", "maintainer", "viewer"),
  "ops.maintenance": requireRole("planner", "maintainer"),
  "ops.crew": requireRole("planner", "maintainer"),
  "ops.planner": allOf(requireRole("planner"), requireAttributeMatch("unit", "unit")),
  /** Who may sign off a sortie confirmation (the sortie-readiness mission's approval). */
  "ops.sortie-signoff": requireRole("planner")
};
