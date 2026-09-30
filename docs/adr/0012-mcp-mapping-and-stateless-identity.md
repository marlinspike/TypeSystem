# 0012. MCP Mapping and Stateless Identity

## Status

Accepted. *Amended by ADR-0050:* `createServer(backend, resolveIdentity,
info?)` takes any registry and runtime, and `resources/list` lists Types only.

## Context

AI agents are a first-class consumer, but the semantic runtime must not
depend on AI, and must remain the sole policy/governance boundary regardless
of which transport a request arrives through. The mission brief specifies a
concrete mapping (Types -> resources, Relationships -> navigable context,
Actions -> tools, Schemas -> JSON Schema, Authorization -> enforcement) and
requires that a human-application path and an AI-agent-via-MCP path carry
equivalent security and governance. The current Model Context Protocol
specification (2026-07-28) is stateless — there are no session IDs — which
has a direct consequence for how identity must be handled.

## Decision

**Resources = read-only browsing, Tools = governed capabilities.**
`packages/mcp-server/src/resources.ts` exposes the type list, an individual
Type's flattened definition (via `describeType()`: name, version,
description, `extends`, `traits`, schema, relationships, action names,
computed property names, `deprecated`, `aliases`), an object, a
relationship's resolved related objects, and a property's provenance — all
as `typesys://` resource URIs, all read via `runtime.getObject` /
`getRelationship` / `getProvenance`, never via any MCP-specific
authorization logic of their own.
`packages/mcp-server/src/tools.ts` maps every registered `ActionDefinition`
onto an MCP `Tool` 1:1 (its own `inputSchema`/`outputSchema`, plus an
injected `authToken` field), and adds exactly one generic `query` tool whose
`inputSchema` is the `SemanticQuery` DSL (ADR-0011) with the same
`authToken` field added. Every tool call routes through
`runtime.invokeAction()` or `runtime.query()` — the same Runtime, same
`PolicyEngine`, same audit path a direct application call would use.

**Identity is resolved fresh from a bearer token on every single call, and
is never cached.** `resolveIdentity(token)`
(`packages/mcp-server/src/auth.ts`) is called inside every resource-read and
every tool-call handler, independently, looking the token up in a small
demo map (`demo-maintainer-token`/`demo-viewer-token`) or falling back to an
anonymous identity. This is not an incidental implementation detail — it is
required by MCP's statelessness: because the current spec has no session
concept, there is nothing to cache identity *onto* even if it seemed
convenient to. `packages/mcp-server/test/mcp-contract.test.ts`'s seventh
step proves this concretely: two consecutive `callTool` invocations on the
same client connection, one with `demo-maintainer-token` (succeeds) and the
very next with `demo-viewer-token` (denied), produce two independently
correct, different authorization outcomes — nothing from the first call's
identity leaks into or is reused by the second.

**The SDK's low-level `Server` class is used, not the high-level `McpServer`
convenience wrapper.** `McpServer`'s tool/resource registration API expects
Zod schemas for validation. This project's canonical schema representation
is JSON Schema (ADR-0001), and the low-level `Server` class validates
requests with Ajv by default — using it avoids introducing Zod as a second,
redundant schema language purely to satisfy the SDK's convenience layer.
`packages/mcp-server/src/server.ts` constructs a plain `Server` and
registers request handlers (`ListResourcesRequestSchema`,
`ReadResourceRequestSchema`, `ListToolsRequestSchema`,
`CallToolRequestSchema`) directly.

## Consequences

- An AI agent and a human application get identical enforcement, because
  both paths terminate in the same `SemanticRuntime` calls — there is no
  parallel "MCP policy" to keep in sync with the Runtime's policy.
- Every MCP call pays the cost of re-resolving identity from a token; there
  is no connection-level identity cache to invalidate or get stale, which
  is the correct tradeoff for a stateless protocol and for a security
  boundary that should re-verify on every call anyway.
- Resource/tool schemas are JSON Schema throughout — an Action's
  `inputSchema` (already JSON Schema, per ADR-0005) becomes a tool's
  `inputSchema` with no conversion step, and the `query` tool's input
  schema is the `SemanticQuery` shape verbatim.
- `resource-uri.ts` builds/parses `typesys://` URIs with plain string
  logic rather than the SDK's `ResourceTemplate` class, deliberately, since
  this vertical slice's URI shapes (types, objects, relationships,
  provenance) are simple enough that a template engine would be
  speculative abstraction.

## Alternatives Considered

- **Caching identity on the MCP connection/session**: rejected — MCP
  2026-07-28 has no session concept to cache it on, and even if it did,
  caching identity across calls would violate the zero-trust,
  re-verify-every-call posture the mission brief requires for AI-agent
  access.
- **The high-level `McpServer` wrapper with Zod schemas**: rejected — it
  would require maintaining a second schema representation (Zod) in
  parallel with the canonical JSON Schema representation used everywhere
  else in the system, for no capability this project needs that the
  low-level `Server` class doesn't already provide.
- **Exposing every backend operation directly as an MCP tool**: rejected
  per the mission brief's explicit caution — only registered `Action`s
  (already governed by policy/precondition/audit) and the one generic,
  read-only `query` tool are exposed; there is no raw adapter or database
  access surfaced to MCP.
