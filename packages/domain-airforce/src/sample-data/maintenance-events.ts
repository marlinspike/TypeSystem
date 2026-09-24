import type { ExternalMaintenanceRecord } from "@typesys/adapter-mock-rest";

export const sampleMaintenanceEvents: ExternalMaintenanceRecord[] = [
  {
    event_id: "EVT-9001",
    aircraft_tail: "AF86-0147",
    event_type: "scheduled",
    event_date: "2026-09-15T09:30:00.000Z",
    notes: "Hydraulic system inspection."
  },
  {
    event_id: "EVT-9002",
    aircraft_tail: "AF86-0147",
    event_type: "unscheduled",
    event_date: "2026-09-19T11:00:00.000Z",
    notes: "Avionics fault reported by crew chief."
  }
];
