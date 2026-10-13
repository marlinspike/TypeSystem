import type { InMemoryRecord } from "@typesys/adapter-in-memory";
import type { ExternalMaintenanceRecord, ExternalWorkOrderRecord } from "@typesys/adapter-mock-rest";

/** The maintainers work orders are assigned to. The demo maintainer is SSgt Rivera (`demoIdentities`). */
export const ASSIGNEES = ["SSgt Rivera", "TSgt Chen"] as const;

export interface Fleet {
  readonly aircraft: InMemoryRecord[];
  readonly events: ExternalMaintenanceRecord[];
  readonly workOrders: ExternalWorkOrderRecord[];
}

/**
 * A squadron of 24 aircraft for the mission application: one in three
 * degraded or down, most with a maintenance history, and work orders open,
 * in progress and closed, assigned to two maintainers. Deterministic, so
 * both versions of the application and their tests see the same fleet.
 */
export function missionFleet(): Fleet {
  const statuses = ["operational", "operational", "degraded", "operational", "down", "operational"] as const;
  const models = ["F-16C", "F-15E", "C-17A", "KC-135R"] as const;
  const aircraft: InMemoryRecord[] = Array.from({ length: 24 }, (_, i) => {
    const tail = `AF90-${String(101 + i).padStart(4, "0")}`;
    return {
      objectId: tail,
      values: {
        id: tail,
        name: `${models[i % models.length]} ${tail}`,
        tailNumber: tail,
        model: models[i % models.length],
        maintenanceStatus: statuses[i % statuses.length],
        lastMaintainedAt: `2026-09-${String(1 + (i % 28)).padStart(2, "0")}T08:00:00.000Z`,
        deploymentLocation: i % 3 === 0 ? "FOB BRAVO (exercise designation)" : "Home station"
      }
    };
  });
  const events: ExternalMaintenanceRecord[] = aircraft.flatMap((a, i) =>
    Array.from({ length: i % 4 === 3 ? 0 : 1 + (i % 2) }, (_, j) => ({
      event_id: `EVT-${a.objectId.slice(5)}-${j + 1}`,
      aircraft_tail: a.objectId,
      event_type: j === 0 ? "inspection" : "repair",
      event_date: `2026-10-${String(1 + ((i + j) % 12)).padStart(2, "0")}T10:00:00.000Z`,
      notes: j === 0 ? "Scheduled phase inspection." : "Hydraulic leak reported after sortie."
    }))
  );
  const workOrders: ExternalWorkOrderRecord[] = events
    .filter((_, k) => k % 3 !== 2)
    .map((e, k) => ({
      wo_id: `WO-${String(k + 1).padStart(4, "0")}`,
      event_id: e.event_id,
      status: k % 4 === 0 ? "closed" : k % 4 === 1 ? "in-progress" : "open",
      assigned_to: ASSIGNEES[k % ASSIGNEES.length]!,
      created_at: "2026-10-12T12:00:00.000Z"
    }));
  return { aircraft, events, workOrders };
}
