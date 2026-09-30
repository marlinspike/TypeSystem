# 0041. Security Labels v2: `decide` and `join`

## Status

Accepted — implemented in `@typesys/core`: the `decide`/`join` interface,
`linearClassification` and `DENY_MARKED_DATA` in the new shape, and the
reference `securityLabels` scheme in `runtime/classification.ts`; the
join-and-each-marking decision in `SemanticRuntime`'s `classify`, the only
place the scheme is asked. Proven by:

- `packages/core/test/security-labels.test.ts` — the reference scheme
  refusing malformed configuration and, in an **attack** block, 17 malformed
  or ambiguous markings (lowercase, trailing space, a two-letter or
  unspaced `REL TO`, `NOFORN` out of place or inside compartments, empty
  segments, `CUI` categories that are releasability words); each dimension
  decided — level, compartments, `REL TO` and `NOFORN`, CUI as a regime no
  clearance reaches and that needs none, and the system's accreditation for
  levels and for CUI; subject attributes of the wrong shape granting
  nothing; joins that take the highest level, union compartments and CUI
  categories, intersect releasability, write "home country only" as
  `NOFORN`, keep what they can't parse, and release to no one when lists
  don't meet; and, over 3,000 generated label sets and subjects, join
  idempotent and order-blind, deciding exactly as the markings do together
  and one by one. In the runtime: a derived value carrying the join of its
  inputs (a U.S. reader sees the fused value, a British one neither it nor
  the Canada-shared input), its audit row naming the label and the scheme's
  reason while the caller's reason stays generic; CUI and accreditation
  through the runtime; a compilation rule honored; an **attack** block of
  joins that weaken, empty, return non-strings or a string, or throw — each
  leaving every marked value closed — plus a weaker join beside a sloppy
  per-marking answer; odd or throwing decisions denying; and the scheme
  seeing the action and resource, never stored values.
- The ADR-0032 and ADR-0034 suites, on the new interface, including the
  linear join, and the audit tripwire pinning `classify` as the scheme's
  only caller.

Mutation-checked (16 mutations, 15 caught): dropping the per-marking floor
or narrowing it to multi-marking inputs, allowing on a scheme failure,
accepting a non-`true` answer for the join or for a single marking, asking
the scheme about unmarked data, a linear join that isn't the maximum,
unioning releasability, not unioning compartments, dropping the CUI
category, level-accreditation, or CUI-accreditation checks, allowing
reserved words as compartments, letting no clearance hold the lowest level,
and a `DENY_MARKED_DATA` that allows. The survivor is equivalent: the
explicit string check on `citizenship` before `Set.has`, which already
answers false for a non-string.

## Context

ADR-0032 made classification a mandatory control beside the policy engine;
ADR-0034 made its default explicit. Its scheme interface is one question:
`dominates(clearance, marking)` — does this one clearance string dominate
this one marking string? That shape fits a linear ladder and little else.
Real information-control models need more at the point of decision:

- **The whole subject**, not one string: compartment access, nationality for
  releasability (`REL TO`, `NOFORN`), authorization for CUI categories.
- **The whole label at once.** `REL TO` lists intersect; a marking set is not
  a set of independent questions once dimensions interact.
- **The environment**: a system accredited to SECRET must not serve TOP
  SECRET, whoever asks.
- **A label for derived data.** A computed property's value is derived from
  its dependencies (ADR-0032 takes the union of their markings and asks
  about each). The label of the result is not, in general, the maximum of
  the inputs: compartments union, releasability intersects, CUI categories
  union — and a scheme may say that some combinations are more sensitive
  than any part (compilation).

CUI in particular is not a rung on the classified ladder (ADR-0034): it is a
separate regime of categories and authorizations, and only a model with
more than one dimension can hold it.

## Decision

**1. The scheme interface is `decide` and `join`.**

```ts
interface ClassificationScheme {
  readonly name: string;
  /** The label of data derived from data under all of `markings`. */
  join(markings: readonly string[]): readonly string[];
  decide(request: { subject: Identity; markings: readonly string[]; context: ClassificationContext }): ClassificationDecision;
}
interface ClassificationContext { action: "read" | "invoke"; resource: { typeName: string; objectId?: string; propertyPath?: string } }
interface ClassificationDecision { allow: boolean; reason?: string }
```

Markings stay strings in schemas and provenance; the scheme parses them. The
subject is the whole `Identity`. A scheme decides whatever dimensions it
models; the runtime never interprets a marking.

**2. The runtime decides the joined label *and* every marking on its own.**
For data under markings `m₁…mₙ` — an object, a member, a stored value, or a
computed value and everything it derives from — access requires
`decide(join(m₁…mₙ))` *and* `decide([mᵢ])` for each `i`. So `join` can only
ever *add* restriction: a scheme with a compilation rule is honored, and a
`join` with a bug can't open data any single marking closes. Unmarked data
still never reaches the scheme (ADR-0034).

**3. Fail closed at every step.** A `join` that throws, or answers anything
but a non-empty list of strings for marked data, denies; so does a `decide`
that throws or answers anything but `allow: true`.

**4. Audit records the label and the scheme's reason; the caller sees
neither.** A classification audit row keeps `details.markings` (the inputs)
and adds `details.label` (the join) and `details.reason` (the scheme's own,
which may name markings). The reason returned to the caller stays "Requires
a higher clearance" (ADR-0032).

**5. The shipped schemes, in the new shape.** `linearClassification`
(and so `DEMO_LINEAR_CLASSIFICATION`) joins to the highest level, keeping any
marking it doesn't recognize so the decision refuses it. `DENY_MARKED_DATA`
joins to its inputs and denies. A new **reference** scheme,
`securityLabels({ levels, homeCountry, accreditation })` — a demonstration of
the model, *not* the CAPCO register — models five dimensions:

| dimension | marking | subject needs | join |
|---|---|---|---|
| level | `SECRET` | `clearance` at least as high | highest |
| compartments | `SECRET//ALPHA/BRAVO` | `attributes.compartments` holding all | union |
| releasability | `…//REL TO USA, GBR`, `…//NOFORN` | `attributes.citizenship` in the list (NOFORN: the home country) | intersection |
| CUI, its own regime | `CUI`, `CUI//PRVCY/LEI` | `attributes.cuiCategories`, holding every category | union |
| accreditation | — | the system itself accredited for the label | — |

A marking it can't parse is refused; so is a subject attribute of the wrong
shape.

## Consequences

- Schemes written against `dominates` must be rewritten; nothing is
  published, so there are none outside this repository.
- For the linear schemes, decisions are unchanged: the join is the maximum,
  which each-marking already implied. What changes is the audit row, which
  now names the label a derived value carries.
- A deployment can model compartments, releasability, and CUI without
  touching the runtime.

**What a human must review before this is trusted in production.** This
code is machine-verified, not human-reviewed.

- **`securityLabels` is a demonstration.** Real marking grammars, the
  dissemination-control register, CUI's limited-dissemination controls, and
  declassification are far richer; a deployment needs a scheme reviewed
  against its actual marking guide.
- **Subject attributes are only as good as the identity provider.** The
  reference scheme trusts `attributes.citizenship` and friends as the
  runtime receives them (ADR-0012's identity resolution).
- **Compilation rules are the scheme's to state.** The runtime honors a
  more restrictive join; it can't discover one.

## Alternatives Considered

- **Keep `dominates` and add dimensions to `Identity`.** Every new
  dimension would be a core model change, and the whole-label and derived-
  label questions would still have nowhere to live.
- **Decide only the join.** Simpler, but a scheme's `join` bug would become
  a data leak; deciding each marking too costs a few in-process calls.
- **Parse markings in the runtime.** It would make one marking grammar the
  runtime's; schemes own their vocabulary.
- **Model CUI as a level.** The error ADR-0034 named: CUI is governed by
  category and authorization, not by height.
