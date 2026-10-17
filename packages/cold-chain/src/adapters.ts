import { HttpAdapter } from "@typesys/adapter-http";
import { INVENTORY, SENSORS, TRACKER } from "./model.js";

/** The shipment tracker: an API key, cursor paging three a page, its own codes for carriers and states. */
export function trackerAdapter(baseUrl: string, apiKey = "tracker-shipper-key"): HttpAdapter {
  return new HttpAdapter({
    dataSourceId: TRACKER,
    system: "Shipment tracker",
    baseUrl,
    auth: { kind: "header", name: "x-api-key", value: apiKey },
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
  });
}

/** The sensor hub: OAuth 2.0 client credentials, readings paged by cursor, and the disposition write. */
export function sensorAdapter(baseUrl: string, scope = "telemetry.read excursions.write"): HttpAdapter {
  return new HttpAdapter({
    dataSourceId: SENSORS,
    system: "Sensor hub",
    baseUrl,
    auth: { kind: "client-credentials", tokenUrl: new URL("/oauth/token", baseUrl).href, clientId: "typesys-coldchain", clientSecret: "coldchain-secret", scope },
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
  });
}

/** The pharmacy inventory: a key per client (the read-only key may not write), facilities as a bare array. */
export function inventoryAdapter(baseUrl: string, key = "inventory-ops-key"): HttpAdapter {
  return new HttpAdapter({
    dataSourceId: INVENTORY,
    system: "Pharmacy inventory",
    baseUrl,
    auth: { kind: "header", name: "x-pharmacy-key", value: key },
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
  });
}
