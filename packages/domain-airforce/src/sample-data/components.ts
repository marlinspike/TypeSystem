import type { InMemoryRecord } from "@typesys/adapter-in-memory";

export const sampleComponents: InMemoryRecord[] = [
  {
    objectId: "comp-001",
    values: {
      id: "comp-001",
      name: "Engine",
      aircraftId: "AF86-0147",
      partNumber: "ENG-100",
      condition: "good"
    }
  },
  {
    objectId: "comp-002",
    values: {
      id: "comp-002",
      name: "Avionics Suite",
      aircraftId: "AF86-0147",
      partNumber: "AVI-200",
      condition: "fair"
    }
  },
  {
    objectId: "comp-003",
    values: {
      id: "comp-003",
      name: "Engine",
      aircraftId: "AF86-0212",
      partNumber: "ENG-100",
      condition: "good"
    }
  }
];
