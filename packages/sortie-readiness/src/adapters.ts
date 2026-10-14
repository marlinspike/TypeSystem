import { HttpAdapter, type HttpTypeMapping } from "@typesys/adapter-http";
import { DEPOT, FLEET, ROSTER } from "./model.js";

/** The fleet registry: API key, cursor paging, its codes for mission capability. */
export function fleetAdapter(baseUrl: string, apiKey = "fleet-reader-key"): HttpAdapter {
  return new HttpAdapter({
    dataSourceId: FLEET,
    system: "Fleet registry",
    baseUrl,
    auth: { kind: "header", name: "authorization", value: `ApiKey ${apiKey}` },
    types: {
      "ops.Aircraft": {
        get: "/v1/airframes/{id}",
        list: { path: "/v1/airframes", items: "/data", next: "/next", cursorParam: "cursor", pageSizeParam: "page_size", pageSize: 2, params: { unit: "unit", base: "base", mds: "mds" } },
        id: "/tail_no",
        fields: {
          tailNumber: "/tail_no",
          mds: "/mds",
          unit: "/unit",
          base: "/base",
          missionCapability: { from: "/mc_status", map: { FMC: "full", PMC: "partial", NMC: "none" } },
          updatedAt: "/updated"
        }
      }
    }
  });
}

/**
 * The parts depot's two schema versions, mapped onto the same Type. An
 * upgrade from v1 to v2 changes this table and nothing a consumer sees.
 */
export const DEPOT_SCHEMAS: Record<1 | 2, HttpTypeMapping> = {
  1: {
    get: "/v1/requisitions/{id}",
    list: { path: "/v1/requisitions", items: "/items", params: { tailNumber: "tail", base: "base" } },
    id: "/doc_no",
    fields: { tailNumber: "/tail", nsn: "/nsn", nomenclature: "/noun", base: "/base", quantity: "/qty", status: "/status", estimatedDelivery: "/eta" }
  },
  2: {
    get: "/v2/requisitions/{id}",
    list: { path: "/v2/requisitions", items: "/requisitions", params: { tailNumber: "aircraft", base: "location" } },
    id: "/document_number",
    fields: {
      tailNumber: "/aircraft/tail",
      nsn: "/item/nsn",
      nomenclature: "/item/nomenclature",
      base: "/location",
      quantity: "/quantity",
      status: { from: "/state", map: { AWAITING: "awaiting", IN_TRANSIT: "in-transit", ISSUED: "issued" } },
      estimatedDelivery: "/estimated_delivery"
    }
  }
};

/** The parts depot: a key issued per base, so the service decides which bases TypeSystem may read. */
export function depotAdapter(baseUrl: string, schema: 1 | 2 = 1, depotKey = "depot-hill-key"): HttpAdapter {
  return new HttpAdapter({
    dataSourceId: DEPOT,
    system: "Parts depot",
    baseUrl,
    auth: { kind: "header", name: "x-depot-key", value: depotKey },
    types: { "ops.Requisition": DEPOT_SCHEMAS[schema] }
  });
}

/** The crew roster: OAuth 2.0 client credentials; personal names only with the roster.pii scope. */
export function rosterAdapter(baseUrl: string, pii = false): HttpAdapter {
  return new HttpAdapter({
    dataSourceId: ROSTER,
    system: "Crew roster",
    baseUrl,
    auth: pii
      ? { kind: "client-credentials", tokenUrl: new URL("/oauth/token", baseUrl).href, clientId: "typesys-ops-pii", clientSecret: "ops-pii-secret", scope: "roster.read roster.pii" }
      : { kind: "client-credentials", tokenUrl: new URL("/oauth/token", baseUrl).href, clientId: "typesys-ops", clientSecret: "ops-secret", scope: "roster.read" },
    types: {
      "ops.CrewMember": {
        get: "/api/members/{id}",
        list: { path: "/api/members", items: "/members", params: { unit: "unit", assignedTail: "assigned_tail" } },
        id: "/id",
        fields: {
          callsign: "/callsign",
          name: "/full_name",
          qualifications: "/quals",
          unit: "/home_unit",
          assignedTail: "/assigned_tail",
          available: { from: "/duty", map: { available: true, leave: false } }
        }
      }
    }
  });
}
