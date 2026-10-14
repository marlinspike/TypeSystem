---
"@typesys/react": minor
"@typesys/policy-cedar": minor
---

The product is TypeSystem, or TypeSys for short (ADR-0064). `@typesys/react` now exports `createTypeSysHooks`, whose provider is `TypeSysProvider`. The Cedar namespace is `TypeSys` (`TypeSys::User`, `TypeSys::Role`, `TypeSys::Action`): rename the namespace in your own Cedar schema and policies. Every other identifier is unchanged.
