---
"@typesys/core": minor
"@typesys/mcp-server": minor
---

No raw identifiers in telemetry (ADR-0047). `telemetryIdentity` now governs object ids as well as the caller: `typesys.object_id` in the clear, `typesys.object_pseudonym` when pseudonymous, and nothing under `"none"`. Unless the policy is `"clear"`, span errors carry only their class name. Pseudonym inputs are tagged, so subject pseudonyms differ from before. `runtime.redactsTelemetryIdentifiers` lets code that opens its own spans follow the policy. The MCP server's spans do: they never record a resource URI's query, where the bearer token rides, and when redacting they show the object id as `{objectId}`. `HIGH_ASSURANCE_V1` widens its telemetry guarantee to every identifier, and adds a seventh: under the profile, engine faults other than the combinators' fixed form are audited as `external-policy-fault`. The tracer is looked up per span, so an SDK registered after `@typesys/core` loads sees its spans.
