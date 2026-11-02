import type { HttpAdapter, HttpTypeMapping } from "@typesys/adapter-http";
import { adapterForSource, emptyEnvironment, overlayEnvironment, type HttpSourceSpec } from "@typesys/host";
import { DEPOT, FLEET, ROSTER } from "./model.js";

/**
 * The three systems as a deployment declares them (ADR-0102): where each is
 * (`$env`), the credential TypeSystem holds for it (`$secret`, with the
 * services' well-known demonstration values as defaults), and how its
 * records map onto the model. `sortieDeployment` lists them.
 */

/** The fleet registry: API key, cursor paging, its codes for mission capability. */
export const fleetSource: HttpSourceSpec = {
  kind: "http",
  system: "Fleet registry",
  baseUrl: { $env: "TYPESYS_OPS_FLEET_URL" },
  auth: { kind: "header", name: "authorization", value: { $secret: "TYPESYS_OPS_FLEET_KEY", prefix: "ApiKey ", default: "fleet-reader-key" } },
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
};

/**
 * The parts depot's two schema versions, mapped onto the same Type. An
 * upgrade from v1 to v2 changes this table, a deployment's `sources`, and
 * nothing a consumer sees.
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

/** The parts depot at one schema version: a key issued per base, so the service decides which bases TypeSystem may read. */
export function depotSource(schema: 1 | 2 = 1): HttpSourceSpec {
  return {
    kind: "http",
    system: "Parts depot",
    baseUrl: { $env: "TYPESYS_OPS_DEPOT_URL" },
    auth: { kind: "header", name: "x-depot-key", value: { $secret: "TYPESYS_OPS_DEPOT_KEY", default: "depot-hill-key" } },
    types: { "ops.Requisition": DEPOT_SCHEMAS[schema] }
  };
}

/** The crew roster: OAuth 2.0 client credentials; personal names only with the roster.pii scope, which only the PII client holds. */
export function rosterSource(pii = false): HttpSourceSpec {
  return {
    kind: "http",
    system: "Crew roster",
    baseUrl: { $env: "TYPESYS_OPS_ROSTER_URL" },
    auth: pii
      ? {
          kind: "client-credentials",
          tokenUrl: { $env: "TYPESYS_OPS_ROSTER_URL", path: "/oauth/token" },
          clientId: "typesys-ops-pii",
          clientSecret: { $secret: "TYPESYS_OPS_ROSTER_PII_SECRET", default: "ops-pii-secret" },
          scope: "roster.read roster.pii"
        }
      : {
          kind: "client-credentials",
          tokenUrl: { $env: "TYPESYS_OPS_ROSTER_URL", path: "/oauth/token" },
          clientId: "typesys-ops",
          clientSecret: { $secret: "TYPESYS_OPS_ROSTER_SECRET", default: "ops-secret" },
          scope: "roster.read"
        },
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
  };
}

/** One system's adapter at `baseUrl`, holding `secret` (or the demonstration default): what the sources above describe. */
function adapter(id: string, spec: HttpSourceSpec, baseUrl: string, urlVar: string, secret?: { readonly name: string; readonly value: string | undefined }): HttpAdapter {
  return adapterForSource(id, spec, overlayEnvironment({ [urlVar]: baseUrl, ...(secret ? { [secret.name]: secret.value } : {}) }, emptyEnvironment), true);
}

export function fleetAdapter(baseUrl: string, apiKey = "fleet-reader-key"): HttpAdapter {
  return adapter(FLEET, fleetSource, baseUrl, "TYPESYS_OPS_FLEET_URL", { name: "TYPESYS_OPS_FLEET_KEY", value: apiKey });
}

export function depotAdapter(baseUrl: string, schema: 1 | 2 = 1, depotKey = "depot-hill-key"): HttpAdapter {
  return adapter(DEPOT, depotSource(schema), baseUrl, "TYPESYS_OPS_DEPOT_URL", { name: "TYPESYS_OPS_DEPOT_KEY", value: depotKey });
}

export function rosterAdapter(baseUrl: string, pii = false): HttpAdapter {
  return adapter(ROSTER, rosterSource(pii), baseUrl, "TYPESYS_OPS_ROSTER_URL");
}
