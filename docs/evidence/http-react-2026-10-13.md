# The HTTP API and React bindings against the baseline, 2026-10-13

Slice 7 of the [roadmap](../roadmap.md),
[ADR-0058](../adr/0058-governed-http-api-and-headless-react-bindings.md).
Compared with [`baseline-2026-10-13.md`](baseline-2026-10-13.md), where
the runtime was reachable in process and over MCP, and a browser app had
only the demo console's own routes to call.

## What an application no longer writes

| Before | Now | Shown in |
|---|---|---|
| An HTTP layer per app, each mapping runtime errors to statuses its own way | `createApiApp`, problems with a stable `code` and the policy's `reason` | `api.test.ts`: "refuses with a problem whose code a client can branch on" |
| A second client for the browser | The same typed SDK client, `httpTransport` instead of `runtimeTransport` | "answers exactly as the runtime does, for every caller" |
| A hand-written API contract | OpenAPI 3.1 generated from the model, request schemas the runtime's own | "the OpenAPI document ... every reference resolves" |
| Loading, error and paging state per screen | `useQuery`, `useObject`, `useActions`, `useAction` | `react.test.ts`: the hooks |
| Form fields and table columns written per Action and Type | `formFields`, `coerceForm`, `columnsFor` | `react.test.ts`: forms and columns |
| Role checks in the UI to hide what a caller can't see or do | Nothing: the runtime withholds values, `useActions` and `preview` say what is allowed | "shows each caller what the runtime gives them" |

The two packages are 804 lines of source. The MCP server's HTTP transport
lost 57 lines and gained 3 by using the shared Host, Origin and bearer
helpers. No app was built and timed against a hand-written equivalent in
this slice; that comparison is slice 10's.

## Equivalence, not a second implementation

The central test writes eight reads once with the typed SDK and runs them
through both transports for the maintainer, the viewer and an anonymous
caller: 24 pairs, compared as JSON with timestamps masked. All 24 match,
including every refusal, compared by message. The API adds no decision of its own, so a difference
would be a defect in the API or the transport.

## What it costs

500 calls of each after 50 warm-up calls, Node 22, in-memory sources with
no simulated latency, the API on loopback in the same process, maintainer
token. Two runs:

| Call | In process p50 | HTTP p50 | In process p95 | HTTP p95 |
|---|---|---|---|---|
| `get` one aircraft | 0.14, 0.14 ms | 1.48, 1.33 ms | 0.26, 0.28 ms | 2.07, 1.67 ms |
| query, filtered on a computed value | 1.66, 1.64 ms | 3.15, 3.10 ms | 2.09, 2.09 ms | 4.21, 4.41 ms |
| Action preview | 1.37, 1.32 ms | 2.66, 2.76 ms | 1.70, 1.56 ms | 3.08, 3.82 ms |

About 1.2 to 1.5 ms per call at p50: identity resolution, JSON both ways,
Express routing and a loopback round trip. A real network adds its own
latency on top; TLS is not measured here.

## Mutation check

14 mutations, each caught by at least one test; ADR-0058 lists them. They
include the two that would leak: the authorization plan returned by
explain, and a 500 carrying its error's message.

## Not shown

No CORS handling, no streaming of workflow state, no ETags, and forms
cover top-level inputs only. The React bindings were exercised with
`react-test-renderer` against React 18.3; React 19 is allowed by the peer
range but not tested here.
