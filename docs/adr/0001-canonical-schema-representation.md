# 0001. Canonical Schema Representation

## Status

Accepted

## Context

The semantic model needs one canonical, machine-readable representation for
a Type's structural shape (properties, required fields, nested types) that
can also carry the project's own concepts — relationships, actions, computed
properties, policy, provenance, metadata — none of which exist in plain
JSON Schema. The representation had to be standards-based (per the mission
brief's "standards-first" principle), validated by mature tooling, and
extensible without inventing a whole new grammar.

## Decision

Use **JSON Schema 2020-12** as the structural foundation, validated with
Ajv (`ajv 8.20.0`'s `Ajv2020` build, plus `ajv-formats` for `format`
keywords), and layer a small **private `x-*` vocabulary** on top of it under
a dedicated vocabulary URI, `https://typesys.dev/vocab/semantic/v1`
(`SEMANTIC_VOCAB_URI` in `packages/core/src/model/vocabulary.ts`). The
vocabulary adds exactly six annotation-only keywords: `x-relationships`,
`x-actions`, `x-computed`, `x-policy`, `x-provenance`, `x-metadata`
(`SEMANTIC_X_KEYWORDS`). A `SemanticTypeSchema` is a plain JSON Schema 2020-12
document (`$id`, `title`, `type`, `properties`, `required`, `allOf`, etc.)
extended with these optional keywords.

The registry (`SemanticRegistry.registerType()`) parses the `x-*` keywords
exactly once, at registration time, into first-class TypeScript records
(`RelationshipDefinition[]`, `ComputedPropertyDefinition[]`, etc.) — the
Runtime never re-parses the raw schema's annotations at request time except
for `x-policy`, which stays on the schema since policy names are looked up
per-request.

## Consequences

- Structural validation (types, enums, required fields, formats) is fully
  delegated to Ajv — no bespoke validator to maintain.
- The vocabulary is additive: a consumer that only wants structural
  validation can ignore the `x-*` keywords entirely; they are pure
  annotations from Ajv's point of view.
- Because Ajv's default `strict` mode rejects unrecognized keywords, every
  `x-*` keyword must be registered with `ajv.addKeyword()` before the first
  schema compiles (see ADR-0004 for the specific gotcha and fix).
- The vocabulary is intentionally small — it does not attempt to model
  everything JSON-LD or RDF could express (see Alternatives).

## Alternatives Considered

- **A custom DSL** (YAML- or TypeScript-flavored, per the mission brief's
  illustrative example): rejected. It would require writing and
  maintaining a parser, a validator, and (eventually) codegen for anything
  that wanted to consume the model, duplicating what JSON Schema tooling
  already provides for free. JSON Schema is also directly reusable as MCP
  tool input/output schemas with zero translation (see ADR-0011/0012).
- **OpenAPI as the canonical representation**: rejected. OpenAPI is
  document/API-shaped (paths, operations, request/response bodies) rather
  than object/Type-shaped; forcing every Type through an OpenAPI schema
  object would still need the same private extensions this project adds to
  plain JSON Schema, without any of OpenAPI's operation-level machinery
  being useful for a Type definition.
- **RDF/OWL-style ontology**: rejected for this project's actual
  requirements. RDF/OWL earns its complexity when open-world reasoning,
  automated inference, or cross-organization ontology alignment are
  required. Nothing in the mission brief calls for automated reasoning over
  the model, and OWL's tooling ecosystem is far less integrated with
  mainstream API/schema tooling (JSON Schema validators, TypeScript/OpenAPI
  generators, MCP) than JSON Schema is. If a future requirement genuinely
  needs open-world inference, it is cheaper to bridge from this model to
  RDF at that point than to adopt OWL as the canonical representation now.
