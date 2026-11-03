# 0104. An Upgrade Is Checked Before It Rolls

## Status

Accepted (2026-11-02). Finding H5 of the deployment design's pressure test
(a thin exposure gate). Implemented in `packages/host/src/check.ts`
(`checkDeployment`, `renderDeployCheck`) and `packages/host/src/cli.ts`
(`typesys deploy check|build`), on ADR-0093's baseline and impact analysis.
Proven by `packages/host/test/check.test.ts`.

## Context

An upgrade by replacing a deployment file or image changes the model, the
rules, the sources and who reads what, all at once. ADR-0093 compares two
baselines of one application; nothing compared two deployments.

## Decision

`typesys deploy check <current.json> <next.json>` builds both in one process
and asks them the same questions, as the deployments' own personas:

- the model's contract (ADR-0056), from the full model, not one caller's view;
- governance, from an inspection of each (the check inspects as itself,
  under a rule only it holds);
- each persona's read of the objects each persona may see in either build,
  plus any named with `--object`, explained per value (ADR-0093);
- every policy, as data and as type-level decisions for every persona;
- queries a consumer depends on (`--queries`), compared by outcome, count
  and which values came back, never the values;
- every consumer's contract (the next deployment's `consumers`, and
  `--consumer contract.json`) against what the next build serves;
- packs, sources and other settings that changed.

It exits 1, with one line per reason, on a consumer whose contract the next
build breaks, a breaking contract change, an exposure (a persona who now
reads a value or gets a result they did not), or a policy that now admits a
persona it refused. Everything else is listed for review. Probes are reads:
nothing is written to either deployment's systems.

## Consequences

Releasing `readinessStatus` to viewers as a new pack version, with no rule
changed, is blocked as the viewer's new read of every Aircraft; adding the
viewer to a maintainer-only rule is blocked twice, as the decision and as
what the viewer now reads. A narrowing change passes and is listed.
Deployments whose sources are real systems are checked against those
systems (or a staging copy) with the environment set as for the server; a
source that does not answer decides nothing and is compared as nothing.
