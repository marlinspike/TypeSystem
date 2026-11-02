import type { HttpAdapter } from "@typesys/adapter-http";
import { adapterForSource, emptyEnvironment, overlayEnvironment, type HttpSourceSpec } from "@typesys/host";
import { INVENTORY, SENSORS, TRACKER } from "./model.js";

/**
 * The cold chain's three systems as a deployment declares them (ADR-0102):
 * where each is (`$env`), the credential TypeSystem holds for it
 * (`$secret`, with the services' well-known demonstration values as
 * defaults), and how its records map onto the model. `coldChainDeployment`
 * lists them; the functions below build one adapter from one of them.
 */

/** The shipment tracker: an API key, cursor paging three a page, its own codes for carriers and states. */
export const trackerSource: HttpSourceSpec = {
  kind: "http",
  system: "Shipment tracker",
  baseUrl: { $env: "TYPESYS_COLDCHAIN_TRACKER_URL" },
  auth: { kind: "header", name: "x-api-key", value: { $secret: "TYPESYS_COLDCHAIN_TRACKER_KEY", default: "tracker-shipper-key" } },
  types: {
    "coldchain.Shipment": {
      get: "/api/v2/shipments/{id}",
      list: { path: "/api/v2/shipments", items: "/shipments", next: "/cursor", cursorParam: "cursor", pageSizeParam: "per_page", pageSize: 3, params: { origin: "from", destination: "to" } },
      id: "/ref",
      fields: {
        origin: "/from_facility",
        destination: "/to_facility",
        carrier: { from: "/scac", map: { NLCF: "Northline Cold Freight", SBRX: "Southbridge Reefer", PLRF: "Polar Freight" } },
        status: { from: "/state", map: { IT: "in-transit", DL: "delivered", HD: "held" } },
        lat: "/gps/lat",
        lon: "/gps/lng",
        departedAt: "/departed",
        eta: "/eta"
      }
    }
  }
};

/** The sensor hub: OAuth 2.0 client credentials, readings paged by cursor, and the disposition write. */
export const sensorSource: HttpSourceSpec = {
  kind: "http",
  system: "Sensor hub",
  baseUrl: { $env: "TYPESYS_COLDCHAIN_SENSORS_URL" },
  auth: {
    kind: "client-credentials",
    tokenUrl: { $env: "TYPESYS_COLDCHAIN_SENSORS_URL", path: "/oauth/token" },
    clientId: "typesys-coldchain",
    clientSecret: { $secret: "TYPESYS_COLDCHAIN_SENSORS_SECRET", default: "coldchain-secret" },
    scope: "telemetry.read excursions.write"
  },
  types: {
    "coldchain.Reading": {
      get: "/v1/readings/{id}",
      list: { path: "/v1/readings", items: "/readings", next: "/next_cursor", cursorParam: "after", pageSizeParam: "limit", pageSize: 24, params: { shipmentId: "consignment" } },
      id: "/seq",
      fields: { shipmentId: "/consignment", logger: "/logger", at: "/ts", temperatureC: "/temp_c" }
    },
    "coldchain.Excursion": {
      get: "/v1/excursions/{id}",
      list: { path: "/v1/excursions", items: "/excursions", params: { shipmentId: "consignment" } },
      id: "/exc_id",
      fields: {
        shipmentId: "/consignment",
        logger: "/logger",
        startedAt: "/began",
        endedAt: "/ended",
        peakC: "/peak_c",
        minutesOut: "/minutes_out",
        severity: { from: "/band", map: { MINOR: "minor", MAJOR: "major", CRITICAL: "critical" } },
        status: { from: "/state", map: { OPEN: "open", CLOSED: "closed" } },
        disposition: "/disposition",
        note: "/note"
      }
    }
  },
  actions: {
    CloseExcursion: { method: "POST", path: "/v1/excursions/{excursionId}/disposition", body: ["disposition", "note"] },
    ReopenExcursion: { method: "POST", path: "/v1/excursions/{excursionId}/reopen", body: [] }
  }
};

/** The pharmacy inventory: a key per client (the read-only key may not write), facilities as a bare array. */
export const inventorySource: HttpSourceSpec = {
  kind: "http",
  system: "Pharmacy inventory",
  baseUrl: { $env: "TYPESYS_COLDCHAIN_INVENTORY_URL" },
  auth: { kind: "header", name: "x-pharmacy-key", value: { $secret: "TYPESYS_COLDCHAIN_INVENTORY_KEY", default: "inventory-ops-key" } },
  types: {
    "coldchain.Site": {
      get: "/api/facilities/{id}",
      list: { path: "/api/facilities", items: "", params: { kind: "type" } },
      id: "/facility_code",
      fields: { name: "/display_name", kind: "/facility_type", city: "/city", lat: "/coords/0", lon: "/coords/1" }
    },
    "coldchain.Lot": {
      get: "/api/lots/{id}",
      list: { path: "/api/lots", items: "/lots", params: { shipmentId: "shipment", siteId: "facility" } },
      id: "/lot_no",
      fields: {
        product: "/product",
        ndc: "/ndc",
        manufacturer: "/mfr",
        doses: "/doses",
        unitCost: "/unit_cost_usd",
        status: { from: "/status", map: { AVL: "available", TRN: "in-transit", QTN: "quarantined", DST: "destroyed" } },
        expiresOn: "/expiry",
        siteId: "/facility",
        shipmentId: "/shipment_ref",
        minTempC: "/storage/min_c",
        maxTempC: "/storage/max_c",
        holdReason: "/hold_reason"
      }
    }
  },
  actions: {
    QuarantineShipmentLots: { method: "POST", path: "/api/shipments/{shipmentId}/quarantine", body: ["reason"] },
    ReleaseShipmentLots: { method: "POST", path: "/api/shipments/{shipmentId}/release", body: [] },
    QuarantineLot: { method: "POST", path: "/api/lots/{lotId}/quarantine", body: ["reason"] },
    ReleaseLot: { method: "POST", path: "/api/lots/{lotId}/release", body: [] }
  }
};

/** One system's adapter at `baseUrl`, holding `secret` (or the demonstration default): what the sources above describe. */
function adapter(id: string, spec: HttpSourceSpec, baseUrl: string, urlVar: string, secret?: { readonly name: string; readonly value: string | undefined }): HttpAdapter {
  return adapterForSource(id, spec, overlayEnvironment({ [urlVar]: baseUrl, ...(secret ? { [secret.name]: secret.value } : {}) }, emptyEnvironment), true);
}

export function trackerAdapter(baseUrl: string, apiKey = "tracker-shipper-key"): HttpAdapter {
  return adapter(TRACKER, trackerSource, baseUrl, "TYPESYS_COLDCHAIN_TRACKER_URL", { name: "TYPESYS_COLDCHAIN_TRACKER_KEY", value: apiKey });
}

export function sensorAdapter(baseUrl: string, scope = "telemetry.read excursions.write"): HttpAdapter {
  const spec = sensorSource.auth?.kind === "client-credentials" ? { ...sensorSource, auth: { ...sensorSource.auth, scope } } : sensorSource;
  return adapter(SENSORS, spec, baseUrl, "TYPESYS_COLDCHAIN_SENSORS_URL");
}

export function inventoryAdapter(baseUrl: string, key = "inventory-ops-key"): HttpAdapter {
  return adapter(INVENTORY, inventorySource, baseUrl, "TYPESYS_COLDCHAIN_INVENTORY_URL", { name: "TYPESYS_COLDCHAIN_INVENTORY_KEY", value: key });
}
