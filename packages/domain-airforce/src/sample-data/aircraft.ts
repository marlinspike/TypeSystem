import type { InMemoryRecord } from "@typesys/adapter-in-memory";

export const sampleAircraft: InMemoryRecord[] = [
  {
    objectId: "AF86-0147",
    values: {
      id: "AF86-0147",
      name: "F-16C Fighting Falcon #0147",
      description: "Block 50 F-16C assigned to the 86th Fighter Wing.",
      tailNumber: "AF86-0147",
      model: "F-16C",
      trackingId: "TRK-0147",
      lastTrackedAt: "2026-09-20T14:00:00.000Z",
      maintenanceStatus: "degraded",
      lastMaintainedAt: "2026-09-15T09:30:00.000Z",
      deploymentLocation: "FOB ALPHA (exercise designation)"
    }
  },
  {
    objectId: "AF86-0212",
    values: {
      id: "AF86-0212",
      name: "F-16C Fighting Falcon #0212",
      description: "Block 50 F-16C assigned to the 86th Fighter Wing.",
      tailNumber: "AF86-0212",
      model: "F-16C",
      trackingId: "TRK-0212",
      lastTrackedAt: "2026-09-20T14:00:00.000Z",
      maintenanceStatus: "operational",
      lastMaintainedAt: "2026-09-10T09:30:00.000Z",
      deploymentLocation: "Home station"
    }
  }
];
