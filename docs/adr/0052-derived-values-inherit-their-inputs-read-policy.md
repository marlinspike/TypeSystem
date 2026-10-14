# 0052. Derived Values Inherit Their Inputs' Read Policy

## Status

Accepted — implemented in `@typesys/core` (`SemanticRuntime.finalizeValues`
and `readProvenance`; `XComputedSpec.releases`,
`ComputedPropertyDefinition.releases`, checked in `SemanticRegistry.registerType`),
persisted by `@typesys/registry-store-postgres`. Proven by:

- `packages/core/test/derived-value-release.test.ts`: a value withheld
  from a caller who can't read its input and shown to one who can; a
  derivation through another computed value; an input with a policy but no
  value (absence is disclosed too); a release letting exactly one input
  through and no other; a marking never released; the audit rows for each
  withholding and each release, naming inputs and no values; the query and
  include paths, where an include filter on a withheld value matches nothing
  whatever the hidden value is; provenance refused for a withheld value and
  leaving a released input out of a released value's; and the registry
  refusing a release of something the value doesn't depend on.
- `packages/domain-airforce/test/readiness-computed-property.test.ts`: the
  demo viewer no longer reads `readinessStatus`, and still reads the
  released `needsAttention`.

Mutation-checked (6 mutations), each failing at least one test: the
withheld value left in place; an input's policy decided only when the
input has a value; releases ignored; a withheld value not counted as an
unreadable input of the next derivation; provenance skipping every
unreadable input, released or not; a release not audited.

## Context

A computed property runs inside the boundary on the object's stored
values, before redaction (ADR-0007, ADR-0022), because it needs them.
ADR-0032 made classification follow the derivation: a computed property
carries every marking of every input. Property policy did not. The demo
showed the result: the viewer, whom `airforce.maintainer-only` denies
`maintenanceStatus`, read `readinessStatus`, which maps `maintenanceStatus`
one to one (`degraded` is always `PMC`). The policy was enforced on the
field and bypassed through its derivation.

`packages/core/test/data-classification.test.ts` pinned the same behavior
on purpose (`notesDigest`, the first four characters of analysts-only
notes, visible to non-analysts), with the reasoning that a policy author
gates a computed property explicitly. In practice nothing tells the author
they need to, the default discloses, and the composition work in the
[roadmap](../roadmap.md) multiplies the exposure: typed projections,
filters on computed values (ADR-0054) and generated UIs all surface
computed properties first.

## Decision

A computed value is readable only by a caller who may read every input
named in its `dependsOn`, as decided by each input's own property policy on
the same object. The rule composes: a computed input that was withheld is
unreadable for the next derivation. An input with a policy is decided even
when the object has no value for it, because `"unknown"` discloses an empty
field as surely as `"PMC"` discloses a full one.

A Type can make an exception, per computed property and per input, with
`releases`:

```jsonc
"x-computed": {
  "needsAttention": { "dependsOn": ["maintenanceStatus"], "binding": "computeNeedsAttention",
                      "releases": ["maintenanceStatus"] }
}
```

A release is the domain author's assertion that the value does not
disclose that input in a way its policy forbids. It is a reviewable line in
the model rather than an implicit property of the code, and every read that
relies on one writes an `allow` audit row with
`details: { control: "derivation", released: [...] }`. A withheld value
writes a `deny` row with `details: { control: "derivation", inputs: [...] }`.
Neither row carries a value.

Markings are never released. Classification already follows the
derivation (ADR-0032) and stays a mandatory control a schema cannot relax.

Provenance follows the value: a withheld value's provenance is refused, as
before; a released value's provenance leaves out any released input the
caller may not read, since a provenance record names the record and field
of the input it describes.

`releases` must be a subset of `dependsOn`; anything else is refused at
registration.

## Consequences

- The demo viewer no longer sees `readinessStatus`. `needsAttention` is
  released from `maintenanceStatus` in `domain-airforce`, with a comment
  saying what it discloses (one bit: `false` means neither down nor
  degraded). The README's three-caller example changes accordingly.
- Reads of a Type with gated inputs write one more audit row per withheld
  or released computed property per object. That is the cost of putting
  each derivation decision on the record.
- A computed property can still reach other systems through
  `ctx.getAdapter` (ADR-0022). Those reads are not governed by this rule;
  they are the derivation's own business, decided by the domain author, and
  remain a documented limitation: what such a derivation discloses about
  objects the caller can't read is not checked.
- `ctx.getProperty` now returns `undefined` for a declared input the object
  has no value for, rather than throwing. Before, a derivation over an
  optional field failed the whole read.

## Alternatives Considered

- **Keep the old rule and document it.** It is the rule ADR-0032 already
  rejected for markings, for the same reason: the default discloses, and a
  derivation launders the restriction.
- **Decide the computed property against its own policy only (require
  authors to add one).** Nothing enforces that the author remembers, and
  the rule would differ between classification and policy for no reason a
  reviewer could state.
- **Information-flow analysis of the compute function.** It would tell a
  bijection from a lossy summary automatically, but needs static analysis
  of arbitrary TypeScript; `releases` puts the same judgment in the model,
  where a reviewer can see it.
- **Release by naming a separate policy that may read the value.** More
  expressive (release to some callers only), but every case found so far is
  "released to whoever can read the object", and a computed property can
  already narrow itself with its own `propertyPolicies` entry. Left open.

## Amendments

**Amended 2026-10-14** (adversarial review, `packages/core/test/pressure-core-enforcement.test.ts`, `pressure-derived-provenance.test.ts`):

- *Undeclared reads.* `ctx.getProperty` read any stored or computed value,
  so a computed property declaring `dependsOn: []` read an officers-only
  field past every gate above, which are all decided over `dependsOn` (a
  subtype's computed property could read a base-protected value the same
  way). Each computed property now gets its own context, and `getProperty`
  returns `undefined` for any name its own `dependsOn` doesn't list. It
  replaces the old error for an undeclared name; `undefined` is the same
  for every object and caller, and keeps a read from failing.
- *A release lifts one policy.* Releasing a computed input lifted
  everything that withheld it, including that input's own withheld inputs
  (releasing `status` released the `code` it maps one to one). A release
  now lifts only the named input's own policy; an input withheld for its own
  inputs passes those on, and they keep withholding the value unless it
  releases them too (which needs them in its `dependsOn`). The `deny` audit
  row lists them apart, as `details.upstream`.
- *Schema checks.* A computed value's schema (ADR-0055) was checked before
  redaction, so a value the caller may not read failed the whole read for
  some objects and not others: an oracle. It is now checked only for values
  the caller's read keeps; a readable invalid value still fails the read.
- *Provenance and markings.* `getProvenance` swallowed every refusal of a
  released input, so it answered for a value withheld because a released
  input was *marked*. A release now lifts only the input's own policy there
  too: its markings (declared and on the value) and its own inputs are
  decided as for any input, and refuse.
