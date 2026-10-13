# 0058. A Governed HTTP API and Headless React Bindings

## Status

Accepted — implemented in the new `@typesys/http` (`createApiRouter`,
`createApiApp`, `openApiDocument`, `toProblem`, `originGuard`), the new
`@typesys/react` (`createTypeSHooks`, `Resource`, `formFields`,
`coerceForm`, `columnsFor`), `@typesys/sdk` (`httpTransport`, `ApiError`),
`@typesys/core` (`IdentityResolver` moved here), and `@typesys/mcp-server`,
whose HTTP transport now uses the Host, Origin and bearer helpers from
`@typesys/http` instead of its own copies. Proven by:

- `packages/http/test/api.test.ts`: eight reads written once with the typed
  SDK (a filtered projection, nested includes, an object with provenance,
  a relationship, a value's provenance, the Actions on one object, an
  Action preview, an execution plan) give byte-identical results in process
  and over HTTP for the maintainer, the viewer and an anonymous caller,
  refusals included. A refusal arrives as an RFC 9457 problem with a stable
  `code` and the policy's `reason`; bad input is `invalid-input` with the
  schema errors, a missing object `not-found`, a failed precondition
  `precondition-failed`. A 500 carries no detail of the error (a
  connection string thrown by the identity resolver reaches `onError`, not
  the caller). A foreign Origin and a rebound Host are refused before
  identity is resolved. Discovery, query validation and the model
  description are served. A governed workflow runs over HTTP: started by
  the maintainer, refused to the maintainer as approver (four-eyes),
  approval details refused to the viewer, approved by the lead, outputs
  refused to anyone but the initiator, a second decision a `conflict`.
  The generated OpenAPI 3.1 document has no dangling reference, and each
  Action's request schema, resolved inside the document, admits and
  refuses what the runtime admits and refuses.
- `packages/react/test/react.test.ts`: `Resource` settles only its latest
  run, keeps the last data while reloading or after an error, and `reset`
  abandons a run in flight. Rendered with `react-test-renderer` over a real
  SDK client: `useQuery` loads a page and appends the next on `loadMore`,
  and the same component shows the maintainer the SECRET
  `deploymentLocation` and the viewer a row without it; `useObject`
  reloads when its id changes and reports an anonymous caller's refusal as
  an error; `useAction` previews (not authorized, would not execute) and
  invokes for the viewer without creating a work order, then previews and
  creates one for the maintainer; `useActions` reports what the caller may
  invoke; a hook outside its provider says so. `formFields` reads an
  Action's inputs (a status enum as a select, the target id marked with the
  Type it names), `coerceForm` turns control values into the input and
  reports what it cannot read, and `columnsFor` marks computed columns as
  not sortable, as the runtime refuses that sort (ADR-0027).

Mutation-checked (14 mutations): the authorization plan returned by
explain; `approved` unchecked; a missing token treated as a known caller; a
500's message sent to the caller; Origin unchecked; Host unchecked;
`$defs` references left unrewritten in OpenAPI; a stale `Resource` run
settling; `reset` not abandoning a run; `loadMore` replacing instead of
appending; `useLoad` ignoring its dependencies; no field required; an
integer field accepting fractions; a computed column sortable. Each fails
at least one test.

## Context

The runtime was reachable in process, over MCP for agents, and through the
demo console's own routes. An application team building a screen had
neither an HTTP API to call from a browser nor a contract to generate a
client from, and every screen would have re-derived form fields and table
columns from schemas by hand. The mandate asks for declarative app
composition (React and forms) without letting the user interface become a
second place where access is decided.

Two failure modes shape the design. A user interface that hides a button
or a column because "this role can't see it" is a second policy, and it
drifts from the first. An HTTP layer that maps errors loosely leaks either
too much (a stack, a connection string) or too little (a bare 500 for a
refusal a client could explain to its user).

## Decision

**The API adds no decision of its own.** Every route resolves the caller
from the bearer token with the deployment's `IdentityResolver` (the type
now lives in core, so the API, MCP and OIDC share one definition) and makes
one runtime call as that caller. There is no default identity; the router
refuses to start without a resolver. Routes cover what the SDK's
`Transport` needs (query, explain, object, relationship, provenance,
listed Actions, preview, invoke), plus aggregate, discovery, query
validation, the model description and, when an engine is given, the
workflow routes. Explain returns the execution plan without the
authorization plan, the same rule as over MCP (ADR-0038, ADR-0054).

**Errors are problems with a code.** Runtime errors map to RFC 9457
problems: `forbidden` 403 (with the policy's `reason`), `not-found` 404,
`invalid-input` 400 (with schema errors), `precondition-failed` 422,
`rate-limited` 429, `conflict` and `workflow-diverged` 409, `unavailable`
503. Anything unrecognized is a 500 whose detail is the constant "Internal
error"; the error itself goes to `onError`. The SDK's `httpTransport`
turns a problem back into an `ApiError` with the same code and reason, so
a client branches on `code`, never on message text.

**The contract is generated from the model.** `openApiDocument` builds
OpenAPI 3.1 from the model description: a path per Type's objects and per
Action, each Action's request typed by its own input schema (with `$defs`
moved into components), and every object value optional because policy may
withhold any of them (ADR-0055). Side effects and idempotency ride along as
`x-typesys-*` extensions, so a tool-calling agent or a generated client
knows what an invocation does before making it.

**The Host and Origin checks are shared.** The guard written for MCP over
HTTP (DNS-rebinding and cross-site protection) moved to `@typesys/http`
and both servers use it. It runs before identity is resolved. The API sends
no CORS headers: a browser app is served from the same origin or through a
proxy that owns CORS.

**The React bindings are headless and typed by the generated model.**
`createTypeSHooks<AirforceModel>()` returns a provider and hooks
(`useQuery`, `useObject`, `useActions`, `useAction`, `useLoad`) that call
the SDK client the provider holds, in process or over HTTP. They render
nothing and decide nothing: what a component shows is what the runtime
returned for that client's caller, and whether an Action is offered comes
from `listActions` and `preview`, not from role checks in the UI. State
lives in a framework-free `Resource` (latest run wins, last data kept while
reloading) bound with `useSyncExternalStore`, so it is testable alone and
reusable from another framework.

**Forms and columns are derived, not written.** `formFields` reads an
Action's input schema (text, number, integer, boolean, select from `enum`,
date-time, and `json` for anything nested), marks the input that names an
instance-scoped Action's target with the Type it names, and `coerceForm`
turns control values into the input. Neither validates beyond parsing: the
runtime's preview and invocation are the validation. `columnsFor` reads a
Type's stored and computed values and marks computed ones unsortable.

## Consequences

- One typed client runs in a server, an agent, a test and a browser; only
  the transport changes, and the equivalence test holds the transports to
  the same answers for every demo caller.
- A screen's access rules are the runtime's. A viewer's table has empty
  cells where the runtime withheld values; a component that wants to hide
  an empty column does so from the data, not from a role.
- Over loopback HTTP a call costs about 1.2 to 1.5 ms more than in process
  at p50 ([evidence](../evidence/http-react-2026-10-13.md)).
- The demo console (`@typesys/demo-web`) keeps its own routes, which
  switch policy engines and stage security scenarios; it is a
  demonstration, not this API, and was not moved onto it.
- Not done: no CORS handling, no streaming or long-poll of workflow state,
  no ETags or conditional requests, no pagination links in responses
  (cursors only), and the bindings have no component library. Forms cover
  top-level inputs only.

## Alternatives Considered

- **GraphQL.** A natural fit for nested includes, but it would be a second
  query language beside the semantic query (ADR-0054) with its own
  authorization surface (resolver-level checks). The REST API carries the
  same `SemanticQuery` the runtime, SDK and MCP use.
- **tRPC or a generated server.** Couples the client to a TypeScript
  server's router types. The SDK is already typed by the generated model;
  the API only needs to carry its calls.
- **A component library with role-aware widgets.** Faster to a first
  screen, but it puts policy in the UI and a styling choice in the
  platform. Headless hooks plus derived descriptors leave both to the
  application.
- **Client-side validation from the schema.** Duplicates the runtime's
  validator and drifts with it; `preview` already returns every blocker
  without executing anything (ADR-0053).
