# 0003. Relationships as First-Class Records

## Status

Accepted

## Context

The mission brief requires relationships to be "first-class objects, not
merely nested JSON," supporting one-to-one, one-to-many, and many-to-many
cardinalities, and optionally carrying their own metadata. A relationship
also needs to be resolvable independently of the object that declares it —
`registry.listRelationships("core.Person")` should answer "what relationships
exist from Person" without first fetching a Person instance.

## Decision

Model a relationship as `RelationshipDefinition`
(`packages/core/src/model/relationship.ts`): `id`, `name`, `sourceType`,
`targetType`, `cardinality` (`"one-to-one" | "one-to-many" |
"many-to-many"`), `inverseName?`, `edgeSchema?` (a `JsonSchema2020` for
relationship-carried metadata), `resolution: {dataSourceId, operation}`,
`version`, `deprecated?`. Relationships are authored inline on a Type via
`x-relationships` (or contributed by a trait), but the registry
materializes them into independent records at registration time
(`store.putRelationship`), indexed by `sourceType` and independently
listable (`registry.listRelationships(sourceType)`,
`packages/core/test/relationship-definition.test.ts`).

This is deliberately **property-graph-flavored**: relationships have
identity, a typed source and target, a cardinality, and an optional inverse
and edge schema — the same primitives a property graph database exposes —
without adopting a graph database or a graph query language. Resolution
still goes through the same `Adapter` interface as any property
(`adapter.resolveRelationship(relDef, sourceObjectId)`), and traversal is a
handful of hops driven by explicit `QueryInclude` entries in a
`SemanticQuery`, not open-ended graph traversal.

## Consequences

- A relationship can be inspected, listed, and reasoned about without
  resolving any actual object graph — useful for MCP's "inspect the
  semantic definition" resource and for tooling built on the registry.
- Symmetric relationships (e.g. `Person.affiliations` <->
  `Organization.members`) declare their `inverse` explicitly; the registry
  does not attempt to infer inverses automatically.
- `edgeSchema` exists as a seam for relationship-carried metadata (e.g. "as
  of what date is this Person affiliated with this Organization") but is
  not exercised by any relationship in the vertical slice.
- Because relationships are not a general graph, there is no relationship
  query language beyond `QueryInclude` (nested relationship inclusion in a
  `SemanticQuery`) — arbitrary multi-hop graph queries are out of scope.

## Alternatives Considered

- **Nested JSON** (a relationship as just another property whose value is
  an array/object of related IDs or inline objects): rejected per the
  mission brief's explicit requirement, and because it would make
  relationships unlistable/uninspectable independent of an object instance,
  and would conflate "the shape of the relationship" with "the shape of one
  resolved instance of it."
- **A full graph database** (e.g. adopting a property-graph engine and a
  graph query language like Cypher/Gremlin): rejected as the mission
  brief's explicit non-goal ("a complete graph database"). The vertical
  slice's relationships are shallow (Aircraft -> Component,
  Aircraft -> MaintenanceEvent -> WorkOrder) and don't justify graph-native
  storage or a graph query language; the registry's own
  `RelationshipDefinition` records give enough of the property-graph shape
  (typed edges, cardinality, inverses) without the operational cost of a
  graph engine.
