# How to classify data

Mark a Type, a property, or a relationship with a classification, and the
runtime enforces the reader's clearance on every read path — beside the
policy engine, never through it, so no policy and no engine swap can relax
it ([ADR-0032](../adr/0032-data-classification-enforcement.md)).

## Mark the data

In the Type's own schema:

```ts
"x-provenance": {
  // Every object of this Type is CUI: an uncleared reader can't read any of them.
  defaultClassification: "CUI",
  properties: {
    // This field is SECRET: a CUI-cleared reader gets the object without it.
    deploymentLocation: { classification: "SECRET" }
  }
}
```

An adapter can also mark an individual value by setting `classification`
on its `ProvenanceRef`; the stricter of the schema's marking and the value's
wins. Unmarked data is unclassified.

## Give identities a clearance

`Identity.clearance` holds the highest level a subject may read. From a real
token, point `@typesys/auth-oidc` at the claim:

```ts
createOidcIdentityResolver({ issuer, clearanceClaim: "clearance" });
```

A missing or unrecognized clearance holds only the lowest level.

## What the reader sees

| Marked | Uncleared reader |
|---|---|
| a Type | `getObject` is refused; `query` returns an empty page, and the adapter is never called; `aggregate` and Actions are refused; related objects of that Type are left out |
| a property | the object comes back without it, and without its provenance |
| a value (by its adapter) | the same, for that one object |
| a computed property's dependency | the computed property is redacted too — derived data inherits its inputs' markings |
| anything a filter, sort, search, or aggregation names | the query is refused (or, for a value marked only by its adapter, the item is dropped) |

Every classification decision on marked data is audited — including the
clearance `listActions` checks for an Action on a classified Type — with
`details.control === "classification"`. Choosing which properties a default
search ranges over is query planning, not a decision, and writes nothing.

## Use another scheme

The default, `US_CLASSIFICATION`, orders `UNCLASSIFIED < CUI < SECRET <
TOP_SECRET`, and markings are exact strings. For other levels pass
`linearClassification([...])`, or implement `ClassificationScheme` directly
for compartments or caveats:

```ts
new SemanticRuntime(registry, adapters, policyEngine, { classification: linearClassification(["PUBLIC", "INTERNAL", "RESTRICTED"]) });
```

A scheme must return `false` for a marking it doesn't recognize; one that
throws denies.

## Verify it

[`packages/core/test/data-classification.test.ts`](../../packages/core/test/data-classification.test.ts)
exercises every read path against every kind of marking, and
[`packages/domain-airforce/test/data-classification.test.ts`](../../packages/domain-airforce/test/data-classification.test.ts)
the demo's SECRET `deploymentLocation`.
