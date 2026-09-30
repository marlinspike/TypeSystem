---
"@typesys/domain-hospital": minor
---

Add many-to-many relationships to the hospital domain, demonstrating ADR-0028: `Patient.providers` and `Provider.patients`, each resolved through the `Appointment` join collection via `byJoinTable`. No new seed data — they traverse the existing appointments.
