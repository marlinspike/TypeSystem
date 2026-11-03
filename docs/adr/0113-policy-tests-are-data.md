# 0113. Policy Tests Are Data

## Status

Accepted (2026-11-03). Implemented in `packages/host/src/tests.ts` and
`typesys deploy test`. The airforce deployment ships
`deployments/airforce.tests.json`. Proven by `packages/host/test/usability.test.ts`.

## Context

`typesys deploy check` compares two builds, so it says what a change does,
but nothing said what a deployment must keep true. A rule edited in place,
by hand or by an agent, was checked only against the build before it.
Policy engines such as Cerbos keep tests as YAML beside the policies and run
them on compile.

## Decision

A deployment's tests are a `typesys.deployment-tests/1` document, by
convention `<name>.tests.json` beside it. Each test runs as one of the
deployment's personas (or `anonymous`) through the governed runtime, and is
one of:

- `read: "<Type>/<id>"`: with `returns` (each property is in the object),
  `withholds` (none is), or `refused: true` (the read is not authorized);
- `query: "<Type>"` or a query: `withholds` (no object returned carries
  any), `returns` (some object carries each, and the query returned some),
  or `refused: true` (the runtime refuses the query). A query test reads
  every page, up to 1,000 objects;
- `invoke: { action, input }`: an Action preview, authorized or, with
  `refused: true`, refused by its policy. Only an authorization blocker is
  a refusal: a target that does not exist or an approval the Action waits
  for says nothing about who may invoke it.

A test whose answer cannot show what it promises is inconclusive, and
fails: a refusal or a withholding over a query that returned nothing, or
an invoke whose target does not exist. Every Type and property a test
names must be in the model, so a misspelt name cannot pass forever.

`typesys deploy test <deployment> [<tests>]` runs them and exits 1 on any
failure, naming what was seen. `typesys dev` runs them on every build.
`typesys init` drafts them.

## Consequences

A deployment carries its intent in a form a reviewer reads and CI runs
locally, and the README's three-caller example is now a test. Tests run
against live sources, so a test over data that changes can fail for that
reason; a `returns` test over an empty query fails rather than passing on
nothing.
