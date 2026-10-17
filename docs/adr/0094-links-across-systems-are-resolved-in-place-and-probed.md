# 0094. Links Across Systems Are Resolved in Place and Probed

## Status

Accepted (2026-10-17). Builds on ADR-0028 (resolution strategies), ADR-0048
(dangling references), ADR-0072 (partial answers), ADR-0088 (inspection)
and ADR-0089 (explanations). Implemented in
`packages/adapter-http/src/http-adapter.ts` (`byOwnField`),
`packages/cold-chain/src/model.ts` (`originSite`, `destinationSite`),
`packages/core/src/runtime/runtime.ts` (the failed source named on a
partial answer) and `packages/devkit/src/links.ts` (`probeLinks`). Exposed
as `typesys app links`. Proven by `packages/cold-chain/test/links.test.ts`,
`packages/devkit/test/links.test.ts`, the own-field case in
`packages/adapter-http/test/http-adapter.test.ts` and the links case in
`packages/compiler/test/uses.test.ts`.

## Context

Systems refer to each other by their own codes. The shipment tracker
names each end of a shipment by the pharmacy inventory's facility code,
`MEM` or `HOU`. The Site with that code is the inventory's. The Cold
Chain model held the code as a string, so a developer joined the two by
hand. That is an extract-and-join TypeSystem exists to make unnecessary.

Three things were missing:

- The HTTP adapter resolved only `byForeignKey` relationships: targets
  that name the source. It could not resolve a source that names its
  targets.
- A developer could not see which links cross systems, whether they
  resolve, or whether their references dangle, short of reading each by
  hand.
- When a link's target system failed, the partial answer (ADR-0072)
  named the source the link is resolved through, not the system that
  failed.

## Decision

**A link is resolved where the data lives, and nothing is copied.** The
HTTP adapter resolves `byOwnField:<field>`. It reads the field from the
source object, through the mapping the adapter already has, and returns
each id it names. The runtime then reads each target from the target's
own source, as it reads any related object. Shipment gains `originSite`
and `destinationSite`, one-to-one and optional. Each is resolved through
the tracker, and each Site is read from the inventory. No system learns
of another, and no table is built.

**Probing a link is explaining it.** `probeLinks(runtime, investigator,
{ as?, types?, sample?, crossSourceOnly? })` explains each relationship
of each Type on a few objects (three by default), through the runtime
(ADR-0089). For each relationship it counts:

- related objects returned;
- objects whose relationship came back empty;
- objects whose relationship a source did not answer;
- relationships cut at `maxRelatedPerObject`.

It shows up to three findings that were not `returned`. A relationship is
empty only when nothing is related: one whose related objects were all
refused counts as refused. Explaining another subject, an object that
subject may not read at all is skipped and counted as not readable,
since its links say nothing about theirs. Up to ten times the sample is
tried to find enough objects the subject may read.

Dangling and refused references are counted only when an inspector
explains someone else's access. Telling a caller their own would name an
object their read leaves out. The runtime's explanation already makes
that distinction, and the probe passes it through. `count` is added to
a relationship's `returned` finding, so the probe reads a number rather
than a sentence.

**A link crosses systems when what it names lives elsewhere.** The
inspection's `crossSource` says a relationship is resolved through
another source than its Type's own. The probe also counts a link whose
target Type lives in another source, which is what `originSite` is. It
reports the Type's own source, the source the link is resolved through,
and the target's source.

**A partial answer names the system that failed.** Every adapter call
passes through the runtime's wrapper. The wrapper now notes, on a source
failure, the source whose call raised it. The innermost call is noted
first. An optional include that fails reports that source. Before, it
reported the source the link is resolved through, which for
`destinationSite` blamed the tracker when the inventory was down.

## Consequences

- `typesys app links <dir> --as <inspector> --for <caller>
  --cross-source` shows every cross-system link and how it resolves for
  that caller. It exits 1 on a dangling reference, so a pipeline can
  refuse one.
- With the inventory stopped, a Shipment is still read from the tracker.
  `originSite`, `destinationSite` and `lots` are reported unavailable from
  `pharmacy-inventory`, and the sensor hub's links still resolve.
- The probe only sees the objects it samples. A reference that resolves
  on three shipments may dangle on the fourth, and the caveat says so.
  It is a check to run, not a constraint the runtime enforces.
- Filtering by a linked object's value (shipments whose destination is a
  hospital) is still two queries. TypeSystem resolves links. It does not
  plan joins across systems, which would be a query engine.
