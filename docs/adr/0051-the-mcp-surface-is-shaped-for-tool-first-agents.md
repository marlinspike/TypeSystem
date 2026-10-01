# 0051. The MCP Surface Is Shaped for Tool-First Agents

## Status

Proposed — not implemented. Would amend ADR-0012 (one Action per tool plus
exactly one generic `query` tool; reads only as resources) and touch
`@typesys/mcp-server` (`tools.ts`, `http-transport.ts`, `auth.ts`) only.
No change to `@typesys/core`: every new tool calls a `SemanticRuntime`
method that already exists.

To be proven by, when implemented:

- A contract test that every read tool returns the same value, and writes
  the same audit rows, as the resource read it mirrors, for an allowed and
  a denied identity on both demo domains.
- A test that `query`, `aggregate`, and every read tool return
  `structuredContent` matching their declared `outputSchema`, and still
  return the same JSON as text.
- A test that each Action's tool annotations follow from its
  `sideEffects` and `idempotency`, for every value of each.
- A test that no registered Action can take a reserved tool name.

## Context

An external review of the repository (2026-10-01) judged the MCP layer
architecturally sound and pointed at four places where it fits today's
agent clients worse than it could. Each was checked against the code:

- **Reads are resources only.** ADR-0012 puts Types, objects,
  relationships, and provenance behind `resources/read`, and Actions plus
  `query` (later `aggregate`) behind `tools/call`. That is clean MCP, but
  many agent frameworks drive MCP servers through tools alone and make
  little or no use of resources, so for them an object can be queried but
  not read by id, and provenance cannot be reached at all.
- **`query` and `aggregate` return only text.** `tools.ts` sets
  `structuredContent` for an Action whose result is an object, but `query`
  and `aggregate` return `JSON.stringify(result)` as a text block, and
  declare no `outputSchema`. A client has to parse prose-shaped JSON for the
  two calls an agent makes most.
- **Action metadata the runtime holds never reaches the agent.**
  `ActionDefinition` already carries `sideEffects`
  (`none | creates | mutates | external`) and `idempotency`
  (`none | key | natural`). `tools/list` sends neither, although MCP tool
  annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`,
  `openWorldHint`) exist for exactly this, and an agent harness uses them to
  decide what may run without confirmation.
- **The protocol version is claimed, not checked.** Comments in
  `http-transport.ts` and `auth.ts` say the server matches the MCP
  2026-07-28 generation. The pinned SDK (`@modelcontextprotocol/sdk`
  1.30.0) has `LATEST_PROTOCOL_VERSION = '2025-11-25'`. The smoke tests
  prove our client and our server agree; they don't prove conformance to a
  spec revision.

## Decision

**1. Read tools beside the resources.** `tools/list` adds
`typesys.describe_type`, `typesys.get_object`, `typesys.get_relationship`,
and `typesys.get_provenance`. Each takes the arguments its resource URI
encodes (plus `authToken`, as every tool does) and calls the same runtime
method the resource handler calls, so policy, classification, audit, and
`NotFoundError` behave identically. Resources stay; they remain the right
primitive for clients that use them.

**2. `query` and `aggregate` are renamed `typesys.query` and
`typesys.aggregate`**, and the `typesys.` prefix is reserved: registering an
Action whose name starts with it fails. Reads can then never collide with a
domain's Actions. The old names stay as aliases for one minor version.

**3. Every non-Action tool returns `structuredContent`** and declares an
`outputSchema` (the runtime's result shape for query and aggregate pages,
the Type's schema wrapped with provenance for objects). The text block is
kept, with the same JSON, for clients that read only text.

**4. Action tools carry annotations derived from the Action.**
`readOnlyHint` is `sideEffects === "none"`; `destructiveHint` is
`sideEffects === "mutates"`; `idempotentHint` is `idempotency !== "none"`;
`openWorldHint` is `sideEffects === "external"`. The read tools are all
`readOnlyHint: true`. Annotations are hints to the client; enforcement is
unchanged and still happens in the runtime.

**5. The code claims only what is tested.** The 2026-07-28 comments in
`auth.ts`, `http-transport.ts` and `docs/architecture.md` have already been
corrected to the revision the pinned SDK negotiates (ADR-0012 and ADR-0021
keep the original wording as the record of what was decided). CI gains a run of
the official MCP conformance suite against the HTTP and stdio servers if
one is available for that revision. Moving to SDK v2 and a newer protocol
revision is a separate decision, made deliberately, with this gate in
place first.

## Consequences

- A tools-only agent can do everything a resource-aware agent can, with
  no TypeS-specific client code.
- **Breaking for clients calling `query` or `aggregate` by name** after the
  alias window. `for-agents.md`, `llms.txt`, both smoke scripts, and the
  demo's MCP Console change with it.
- `tools/list` grows by four tools regardless of domain size. It still
  grows by one per Action; that is follow-up C below, not this decision.
- The tool surface now states side effects the runtime already knew, so an
  inaccurate `sideEffects` on an Action becomes visible to agents. That is
  intended.

**What a human must review before this is trusted in production.**

- **Annotations are advisory.** A client may ignore `destructiveHint`.
  Nothing here gates a dangerous Action on human approval; that is
  follow-up B.
- **`structuredContent` duplicates the text block**, so a response is
  roughly twice the size. Check that response-size limits at the gateway
  still hold for a maximal `query` page.

## Alternatives Considered

- **Leave reads as resources only.** Correct by the spec, and it leaves
  tools-only agents unable to read an object by id or see provenance.
- **Replace resources with tools.** Loses resource subscriptions and the
  `typesys://` URIs other clients already use, for no gain.
- **One generic `typesys.read` tool taking a `typesys://` URI.** Fewer
  tools, but the agent sees one opaque string argument instead of four
  schemas that say what each read needs.
- **Unprefixed read tool names (`get_object`).** Collide with any domain
  that names an Action the same way.
- **Add `risk` and `approval` fields to `ActionDefinition` now.** That is a
  core meta-model change with its own enforcement questions; it should not
  ride along with a transport change.

## Follow-ups (each its own decision, not decided here)

- **A. Instance-scoped Action authorization.** ADR-0030 left this open:
  Actions are authorized per Type, not per target object, and need an
  Action→target binding first. For agents this matters more than for
  reads; the risk is an agent closing the wrong `WorkOrder`.
- **B. Action risk and approval semantics.** Something like
  `risk: low | high` and `approval: none | human-required` on
  `ActionDefinition`, enforced by the runtime (an Action needing approval
  refuses without an approval token) rather than left to the client.
- **C. Tool discovery at scale.** `tools/list` returns every Action. A
  registry with hundreds would want domain-scoped listing, search, or
  deferred exposure.
- **D. A full remote-MCP authorization mode.** Today the HTTP server
  verifies a bearer token and expects a gateway in front (ADR-0021). A
  public deployment mode would serve protected-resource metadata and take
  part in MCP's authorization-server discovery itself.
- **E. An agent evaluation suite.** Tests of whether an agent behaves
  correctly against TypeS: hidden properties, denied rows, short pages,
  provenance ambiguity, dangerous Actions, prompt injection stored in
  object fields, stale data, and unavailable adapters. Distinct from the
  contract tests, which check that TypeS answers correctly.
