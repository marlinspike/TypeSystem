---
"@typesys/core": minor
"@typesys/domain-hospital": minor
---

Row-level (instance) authorization (ADR-0030): `PolicyRequest.resource.attributes` carries the object's stored values on instance-level requests, and the runtime decides the object policy per instance on every read path — `getObject`, each returned `query` item (denied items are dropped silently and audited; `query` no longer throws `AuthorizationError` for the object policy), a relationship's source and targets, and provenance. Property and relationship policies now narrow the object policy instead of replacing it, aggregation fails closed under a rule that needs attributes, and the enforcement point is deny-biased (a throwing or malformed policy decision denies). Adds the `requireAttributeMatch`, `anyOf`, and `allOf` rule helpers and the `PolicyResource` type. The hospital domain's `hospital.read-patient` is now per-instance: a clinician reads only patients assigned to them (`Patient.assignedClinicianId` against the identity's `providerId`), a patient only their own record; `hospitalDemoIdentities` gains `otherClinician`.
