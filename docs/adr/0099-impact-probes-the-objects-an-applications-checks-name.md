# 0099. Impact Probes the Objects an Application's Checks Name

## Status

Accepted (2026-10-17). Found in stage E of the developer showcase's
challenge (transcript `docs/evidence/showcase-challenge/transcript/07-evolve.txt`).
Amends ADR-0093 (change impact). Implemented in
`packages/devkit/src/impact.ts` (`BaselineOptions.objects`) and
`packages/compiler/src/cli.ts` (`typesys app impact`). Proven by
`packages/devkit/test/impact.test.ts`.

## Context

A baseline probes the first object of each Type for every caller, and an
impact comparison observes how those reads are decided after a change. The
challenge removed the embargo condition from the recall read policy. The
comparison reported the predicted governance change but no observed one: the
first notice is public, so every caller's read of it was decided the same
before and after. The embargoed notice, the one object the change exposed,
was never probed.

## Decision

`recordBaseline` takes `objects`, probed beside the first of each Type.
`typesys app impact` passes every object the application's acceptance checks
name. Those are the objects its requirement treats differently.

## Consequences

The same change is now reported with 28 new exposures, among them every
field of the embargoed notice returned to the coordinator and to the
auditor, and the command exits 1. An object no check names can still be
decided differently from those probed; the comparison's caveat says so.
