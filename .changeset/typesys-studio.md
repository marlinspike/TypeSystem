---
"@typesys/studio": minor
"@typesys/sdk": minor
"@typesys/http": minor
---

TypeSys Studio (ADR-0061). New `@typesys/studio`: `createStudioApp` serves the governed API under `/api` beside a browser client, under a strict Content Security Policy, with no authority of its own: every screen is the signed-in person's own API calls. Screens: the model with discovery; a query editor with live validation, one-click suggestions, the execution plan for this caller, paged results and the typed SDK code for the query; and Action forms that preview before they invoke, invoking only the previewed input after confirmation. `npm run studio` serves it over the airforce demo. The SDK adds `querySource`, a query as the fluent code that builds it, and `httpCall`, one authenticated API call, now used by `httpTransport`. The API adds `GET /me`.
