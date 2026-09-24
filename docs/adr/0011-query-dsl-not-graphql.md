# 0011. Query DSL, Not GraphQL

## Status

Accepted

## Context

Consumers need a way to ask for an object, filtered sets of objects, and
related objects, without knowing where the underlying data resides — e.g.
"find aircraft where status = NMC and base = Langley." The mission brief
explicitly asks that this not default to inventing "a massive proprietary
query language prematurely," and to evaluate GraphQL and structured JSON
queries as alternatives.

## Decision

Use a small structured JSON query DSL (`packages/core/src/model/query.ts`):
`QueryOperator` (`"eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "in" |
"contains"`), `QueryCondition` (`{property, operator, value}`),
`QueryFilter` (a `QueryCondition`, or `{and: QueryFilter[]}` /
`{or: QueryFilter[]}` for boolean composition), `QueryInclude`
(`{relationship, filter?, include?}` for nested relationship inclusion),
and `SemanticQuery` (`{type, filter?, include?, includeProvenance?, limit?,
cursor?}`). `SemanticRuntime.query()` resolves a `SemanticQuery` by
delegating filtering to `adapter.queryByType(type, filter, limit, cursor)`
and a shared filter interpreter, `matchesFilter()`
(`packages/core/src/runtime/filter.ts`), that any adapter can reuse rather
than reimplementing filter semantics per adapter — both
`InMemoryRepositoryAdapter` and `MockRestAdapter` call the exact same
function.

This shape doubles directly as the MCP `query` tool's `inputSchema`
(`packages/mcp-server/src/tools.ts`'s `QUERY_TOOL_INPUT_SCHEMA`) with zero
translation — an agent calling the `query` MCP tool is passing (almost)
exactly a `SemanticQuery` object, plus the injected `authToken` field.

## Consequences

- Filtering, boolean composition, and relationship inclusion are expressed
  in one small, closed vocabulary that every adapter must support the same
  way — an adapter that can't interpret `QueryFilter` semantics correctly
  would silently return wrong results, so the shared `matchesFilter()`
  helper exists specifically to make "reuse the reference interpreter"
  the easy default rather than something each adapter reinvents.
- There is no query language feature (fragments, subscriptions, custom
  resolvers, arbitrary nested selection sets) beyond what `SemanticQuery`
  models — deep or open-ended traversal is out of scope, matching the
  "not a full graph database" stance in ADR-0003.
- Because the DSL is plain JSON, it needs no separate schema language of
  its own to describe as an MCP tool input — it is already a JSON Schema
  shape by construction.

## Alternatives Considered

- **GraphQL**: rejected. Adopting GraphQL would mean maintaining a second
  schema language and execution engine alongside the JSON-Schema-based
  Semantic Model and MCP's JSON-Schema-based tool inputs — every Type,
  Action input, and query shape would need to exist in both JSON Schema and
  GraphQL SDL, or one would need to be generated from the other. GraphQL's
  real strengths — client-specified field selection, and a rich type system
  with interfaces/unions — are not problems this project has: the semantic
  model already defines exactly what's returned, and an MCP agent consumer
  doesn't benefit from hand-tuning field selection the way a web client
  does. Revisit if a future UI-heavy consumer genuinely needs
  client-driven field selection at scale.
- **A bespoke, more expressive query language** (a small parsed string
  grammar, SQL-like or otherwise): rejected as unnecessary complexity — a
  parser and grammar to design, document, and secure (injection-style
  concerns) for capabilities the structured JSON DSL already covers
  (equality/comparison/set membership/containment, boolean composition,
  relationship inclusion).
