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

(And configure a scheme that understands both — see "Choose a scheme" below.)

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

## Choose a scheme — marked data is denied until you do

With no scheme configured, the runtime uses `DENY_MARKED_DATA`
([ADR-0034](../adr/0034-classification-scheme-defaults.md)): unmarked data
reads as before, and marked data is denied whatever the reader's clearance.
Classification can't be switched off by forgetting to configure it; audit
rows name the scheme that decided (`details.scheme: "deny-marked-data"`), so
this is easy to spot.

`DEMO_LINEAR_CLASSIFICATION` orders `UNCLASSIFIED < CUI < SECRET <
TOP_SECRET` for demos and tests. It is **not** the US classification model:
real markings carry compartments and dissemination controls, and CUI is a
separate regime, not a level between UNCLASSIFIED and SECRET. For your own
levels pass `linearClassification([...], name)`:

```ts
new SemanticRuntime(registry, adapters, policyEngine, {
  classification: linearClassification(["PUBLIC", "INTERNAL", "RESTRICTED"], "acme-internal")
});
```

## Model more than a ladder

A scheme answers two questions
([ADR-0041](../adr/0041-security-labels-v2.md)): `decide({ subject,
markings, context })` — may this whole subject have data under this whole
label — and `join(markings)` — the label of data derived from all of them,
which a computed property's value carries. The runtime decides the join
*and* each marking on its own, so a join can add restriction (a compilation
rule) but never remove it.

`securityLabels` is a reference scheme with five dimensions — a
demonstration, not the CAPCO register:

```ts
classification: securityLabels({ levels: ["UNCLASSIFIED", "CONFIDENTIAL", "SECRET", "TOP_SECRET"], homeCountry: "USA",
                                  accreditation: { level: "SECRET", cui: true } })
```

| marking | the reader needs |
|---|---|
| `SECRET` | `clearance` at least SECRET |
| `SECRET//ALPHA/BRAVO` | … and `attributes.compartments` holding ALPHA and BRAVO |
| `SECRET//REL TO USA, GBR` · `SECRET//NOFORN` | … and `attributes.citizenship` in the list (NOFORN: the home country) |
| `CUI//PRVCY` | `attributes.cuiCategories` holding PRVCY — CUI is its own regime, which no clearance reaches |

The system itself must be accredited for the label, whoever reads. Joins
take the highest level, union compartments and CUI categories, and
intersect releasability. Markings are exact strings; one the scheme can't
parse is refused, and a scheme that throws — or answers anything but
`allow: true` — denies. Audit rows record the joined label and the scheme's
own reason; the caller's reason stays generic.

## Verify it

[`packages/core/test/data-classification.test.ts`](../../packages/core/test/data-classification.test.ts)
exercises every read path against every kind of marking, and
[`packages/domain-airforce/test/data-classification.test.ts`](../../packages/domain-airforce/test/data-classification.test.ts)
the demo's SECRET `deploymentLocation`;
[`packages/core/test/security-labels.test.ts`](../../packages/core/test/security-labels.test.ts)
the multi-dimensional model, joins of derived values, and broken schemes.
