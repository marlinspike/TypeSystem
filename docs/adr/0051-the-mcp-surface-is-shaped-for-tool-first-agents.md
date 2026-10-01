# 0051. The MCP Surface Is Shaped for Tool-First Agents

## Status

Accepted — implemented in `@typesys/mcp-server` (`tools.ts`, and the new
`reads.ts` and `output-schemas.ts`; `resources.ts` now calls `reads.ts`),
with a conformance gate in `scripts/mcp-conformance.ts` and CI. No change to
`@typesys/core`: every new tool calls a `SemanticRuntime` or registry method
that already existed. Amends ADR-0012, which exposed one tool per Action
plus exactly one generic `query` tool, with reads only as resources.
Proven by:

- `packages/mcp-server/test/agent-surface.test.ts`:
  - each read tool against the resource it mirrors, for every read (every
    Type, a Type, an unknown Type, an object, a missing object, a
    relationship, a stored and a computed property's provenance) as three
    identities (maintainer, viewer, anonymous): the same value or the same
    refusal, and the same audit rows, of which there are some for every
    runtime read;
  - every TypeS tool returning `structuredContent`, validated by the MCP
    client against the `outputSchema` it was listed with, and the same JSON
    as text;
  - the annotations of every `sideEffects` × `idempotency` combination, and
    what `tools/list` sends;
  - a registry with an Action named `typesys_…` refused by `tools/list`,
    and such a name never reaching the Action;
  - `query` and `aggregate` answering exactly as the new names do, unlisted.
- `packages/domain-hospital/test/row-level-authorization.test.ts`: clinician
  B is refused clinician A's patient through `typesys_get_object` too, with
  no PHI in the refusal.
- `npm run conformance:mcp`, run in CI: the official suite
  (`@modelcontextprotocol/conformance` 0.1.16) against the HTTP server.
  Shown to fail on a failure missing from the baseline and on a stale
  baseline entry.

Mutation-checked (16 mutations), each failing at least one test: a read
tool skipping provenance, or ignoring the caller's identity; TypeS's tools
returning no `structuredContent`, a `structuredContent` that differs from
the text, or a relationship's text that differs from its structured form;
`typesys_list_types` skipping `describeType`; an `outputSchema` stricter
than the runtime's result; an `external` Action not reported destructive;
`key` idempotency not reported idempotent; Action tools sent without
annotations; TypeS's tools claiming an open world; `tools/list` accepting
an Action with the prefix; a prefixed name reaching `invokeAction`; the old
names dropped, or listed; read-tool arguments unchecked.

## Context

An external review of the repository (2026-10-01) judged the MCP layer
sound and pointed at four places where it fits today's agent clients worse
than it could. Each was checked against the code:

- **Reads were resources only.** ADR-0012 put Types, objects,
  relationships, and provenance behind `resources/read`, and Actions plus
  `query` (later `aggregate`) behind `tools/call`. That is clean MCP, but
  many agent frameworks drive MCP servers through tools alone. For them an
  object could be queried but not read by id, and provenance could not be
  reached at all.
- **`query` and `aggregate` returned only text.** `tools.ts` set
  `structuredContent` for an Action whose result was an object, but `query`
  and `aggregate` returned `JSON.stringify(result)` as a text block, with
  no `outputSchema`. A client had to parse the JSON out of the text for the
  two calls an agent makes most.
- **Action metadata the runtime held never reached the agent.**
  `ActionDefinition` already carried `sideEffects`
  (`none | creates | mutates | external`) and `idempotency`
  (`none | key | natural`). `tools/list` sent neither, although MCP tool
  annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`,
  `openWorldHint`) exist for exactly this, and an agent harness uses them
  to decide what may run without confirmation.
- **The protocol version was claimed, not checked.** Comments said the
  server matched the MCP 2026-07-28 generation; the pinned SDK
  (`@modelcontextprotocol/sdk` 1.30.0) negotiates 2025-11-25 at most. The
  smoke tests proved our client and our server agree, not that either
  conforms to a spec revision.

## Decision

**1. A tool twin for each resource read.** `typesys_list_types`,
`typesys_describe_type`, `typesys_get_object`, `typesys_get_relationship`,
and `typesys_get_provenance` take what the resource URI encodes (`type`,
`id`, `relationship`, `property`) plus `authToken`, as every tool does. A
resource and its twin call the same function in `reads.ts`, so policy,
classification, audit, and errors cannot drift apart. Read-tool arguments
must be non-empty strings, checked before the runtime is asked, since the
low-level SDK `Server` does not validate tool input. Resources stay.

**2. TypeS's tools share the reserved prefix `typesys_`.** `query` and
`aggregate` become `typesys_query` and `typesys_aggregate`. An underscore,
not the dot first proposed: the Claude and OpenAI tool-calling APIs accept
only `[A-Za-z0-9_-]` in a tool name, and many agent frameworks pass MCP
tool names straight through to them. The reservation is enforced in the
MCP layer, not the registry: `tools/list` fails, naming the Actions, when
the registry holds one with the prefix, and a call by a prefixed name that
isn't TypeS's is refused without reaching `invokeAction`. Failing loudly
beats hiding the Action, which would leave an agent unable to tell why it
is missing. The old names are accepted on call, but not listed, for one
minor version.

**3. TypeS's tools return `structuredContent`** with a declared
`outputSchema` (`output-schemas.ts`). One tool serves every Type, so an
object's `values` are an open object rather than the Type's own schema; the
Type's schema is one `typesys_describe_type` call away. `structuredContent`
must be an object, so lists are wrapped: `{ types }`, `{ objects }`,
`{ provenance }`. It is parsed back from the text block, so the two are
exactly the same JSON and both are what crosses the wire. The schemas use
only keywords every JSON Schema draft understands, since the client
validates with whatever it has.

**4. Action tools carry annotations derived from the Action.**
`readOnlyHint` is `sideEffects === "none"`; `destructiveHint` is
`sideEffects` of `mutates` or `external`; `idempotentHint` is
`idempotency !== "none"`; `openWorldHint` is `sideEffects === "external"`.
All four are always sent, because MCP's defaults (destructive, not
idempotent, open world) would otherwise speak for the Action. An
`external` side effect counts as possibly destructive, which the proposal
did not: TypeS cannot see what the external system does with it. TypeS's
own tools are all read-only, idempotent, and closed-world.

**5. The code claims only what is tested.** The 2026-07-28 comments were
corrected to the revision the pinned SDK negotiates (ADR-0012 and ADR-0021
keep their original wording as the record of what was decided). CI runs
the official MCP conformance suite against the HTTP server.
`scripts/mcp-conformance-baseline.yml` lists each expected failure with its
reason, and the suite fails the build on an unlisted failure or a listed
scenario that now passes. Moving to SDK v2 and a newer protocol revision
is a separate decision, now made with this gate in place.

The suite's first run, before any change here and again after, gave the
same result. Six scenarios pass (initialize, ping, tools list, simple
text, tool error, resources list). Twenty-four are baselined. Thirteen
use fixtures that exist only in the suite's reference server, nine probe
capabilities TypeS does not declare (logging, completions, subscriptions,
prompts), and one needs sessions, which a stateless server has none of.
The last, `dns-rebinding-protection`, is a real gap (follow-up F).

## Consequences

- An agent that uses only tools can do everything one that uses resources
  can, with no TypeS-specific client code.
- **Breaking for clients calling `query` or `aggregate` by name** once the
  alias window closes. `for-agents.md`, `llms.txt`, the smoke and load-test
  scripts, the demo's MCP Console, and every test moved to the new names.
- `tools/list` grows by five tools whatever the domain's size. It still
  grows by one per Action; that is follow-up C.
- An inaccurate `sideEffects` on an Action is now visible to agents. That
  is intended.
- The root package gains a pinned dev dependency on the conformance suite,
  which brings Octokit and Undici with it, for development only. It uses the
  same MCP SDK version, deduplicated.

**What a human must review before this is trusted in production.**

- **Annotations are advisory.** A client may ignore `destructiveHint`.
  Nothing here makes a dangerous Action wait for a human; that is
  follow-up B.
- **A response is about twice the size**, since `structuredContent` repeats
  the text. Check that a gateway's response-size limits still hold for a
  maximal `typesys_query` page.
- **`typesys_list_types` and `typesys_describe_type` are not authorized**,
  exactly as the resources they mirror aren't: a Type's definition,
  including its policies' names and markings, is visible to any caller. That
  was ADR-0012's choice and is unchanged here, but a tools-only agent now
  reaches it with no extra step.

## Alternatives Considered

- **Leave reads as resources only.** Correct by the spec, and it leaves
  tools-only agents unable to read an object by id or see provenance.
- **Replace resources with tools.** Loses the `typesys://` URIs that
  clients already use, for no gain.
- **One generic `typesys_read` tool taking a `typesys://` URI.** Fewer
  tools, but the agent sees one opaque string instead of schemas saying
  what each read needs.
- **A `typesys.` prefix.** The proposal's choice, rejected on
  implementation: tool names with a dot are refused by the tool-calling
  APIs most agent frameworks sit on.
- **Unprefixed read tool names (`get_object`).** Collide with any domain
  that names an Action the same way.
- **Enforce the prefix in the registry.** Fails earlier, at registration,
  but puts an MCP naming rule into `@typesys/core`, which knows nothing of
  MCP.
- **List the old names as well.** Agents would see each tool twice and
  pick either; unlisted aliases keep old clients working without that.
- **`destructiveHint` only for `mutates`.** The proposal's mapping. An
  `external` Action can do anything on the far side, so it is reported as
  possibly destructive.
- **Add `risk` and `approval` fields to `ActionDefinition` now.** A core
  meta-model change with its own enforcement questions; it should not ride
  along with a transport change.

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
- **F. Host and Origin validation.** Found by the conformance suite: the
  HTTP server accepts any `Host` and `Origin`, so a web page can reach a
  server bound to localhost through DNS rebinding (GHSA-w48q-cv73-mx4w).
  The demo, whose tokens are public constants, is the sharpest case. Likely
  an `allowedHosts`/`allowedOrigins` option on `createHttpApp`, defaulting
  to localhost when bound to it. Remove the baseline entry when fixed.
