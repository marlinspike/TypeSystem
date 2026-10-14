---
"@typesys/core": minor
"@typesys/http": minor
"@typesys/adapter-http": minor
---

Independent services behind one governed contract (ADR-0072). New
`@typesys/adapter-http`: a declarative Adapter for JSON services, with
JSON Pointer mappings, code tables, cursor paging, API-key or OAuth client
credentials, and `SourceRefusedError` when the service refuses
TypeSystem's credential. In the core, a relationship may be `optional`:
when its source fails, an include is left out and named in the object's
`unavailable` list rather than failing the read or returning `[]`. The
HTTP API maps `SourceRefusedError` to 502 `source-refused` and describes
`unavailable` in its OpenAPI document.
