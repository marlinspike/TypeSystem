import type { InMemoryRecord } from "@typesys/adapter-in-memory";

export const sampleProviders: InMemoryRecord[] = [
  {
    objectId: "PR-2001",
    values: { id: "PR-2001", displayName: "Dr. Priya Nair", specialty: "Cardiology" }
  },
  {
    objectId: "PR-2002",
    values: { id: "PR-2002", displayName: "Dr. Marcus Webb", specialty: "Orthopedics" }
  }
];
