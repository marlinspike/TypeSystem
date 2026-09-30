---
"@typesys/core": minor
---

A missing object is not found (ADR-0048). `getObject` — and the source object of `getRelationship` and `getProvenance` — now raise the new `ObjectNotFoundError` (a `NotFoundError` carrying `typeName` and `objectId`) for an id no source holds, where they used to return an object with empty `values`. It is raised only after the policy decision, so a caller the policy denies gets the same `AuthorizationError` for a missing id as for a forbidden one. A reference to an object no source holds is now left out of a relationship or `include`, as a related object the caller may not read already was. Breaking for a caller that tested for empty `values`; such a caller should catch `NotFoundError`.
