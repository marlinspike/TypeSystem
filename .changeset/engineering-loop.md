---
"@typesys/engineer": minor
"@typesys/cli": minor
"@typesys/domain-airforce": minor
---

The engineering loop (ADR-0071). `@typesys/engineer` adds a mission spec
(`typesys.mission/1`) and `plan`, `scaffold` and `verify`, offered as a
library, as `typesys engineer`, and as MCP tools. A mission states a
requirement, its callers, and acceptance checks the runtime decides
through the application's API. `verify` builds the application, starts it,
and runs every check as each caller, reporting diagnostics with codes,
locations and fix hints. The airforce domain adds a `demo-lead-token` and
exports `airforceWorkflows`.
