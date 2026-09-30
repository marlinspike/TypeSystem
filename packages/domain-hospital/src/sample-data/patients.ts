import type { InMemoryRecord } from "@typesys/adapter-in-memory";

export const samplePatients: InMemoryRecord[] = [
  {
    objectId: "PT-1001",
    values: {
      id: "PT-1001",
      name: "Jordan Lee",
      medicalRecordNumber: "MRN-1001",
      dateOfBirth: "1985-03-14",
      assignedClinicianId: "PR-2001"
    }
  },
  {
    objectId: "PT-1002",
    values: {
      id: "PT-1002",
      name: "Amara Okafor",
      medicalRecordNumber: "MRN-1002",
      dateOfBirth: "1993-11-02",
      assignedClinicianId: "PR-2002"
    }
  }
];
