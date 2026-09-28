import type { InMemoryRecord } from "@typesys/adapter-in-memory";

export const sampleAppointments: InMemoryRecord[] = [
  {
    objectId: "APT-3001",
    values: {
      id: "APT-3001",
      patientId: "PT-1001",
      providerId: "PR-2001",
      scheduledAt: "2026-10-02T09:30:00.000Z",
      status: "scheduled"
    }
  },
  {
    objectId: "APT-3002",
    values: {
      id: "APT-3002",
      patientId: "PT-1001",
      providerId: "PR-2002",
      scheduledAt: "2026-09-15T14:00:00.000Z",
      status: "completed"
    }
  },
  {
    objectId: "APT-3003",
    values: {
      id: "APT-3003",
      patientId: "PT-1002",
      providerId: "PR-2001",
      scheduledAt: "2026-10-05T11:15:00.000Z",
      status: "scheduled"
    }
  }
];
