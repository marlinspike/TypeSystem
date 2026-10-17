# Roadmap 4.0: the semantic application compiler

This document is updated in the same commit as the work it describes.
[`roadmap-3.md`](roadmap-3.md) records the hardening and the engineering
loop this builds on. [`completeness.md`](completeness.md) stays the source
of truth for what exists.

## What 4.0 is for

A 3.0 mission (`typesys.mission/1`) describes a governed application in a
small fixed shape: one workflow of four step kinds and some tables. 4.0
replaces that shape with a typed, versioned application IR
(`typesys.app/1`) built from five composable primitives: governed reads,
expressions, workflow steps, interface nodes and effects. A checker types
every reference against the model and the host's own policy answers
before any code exists. A deterministic, incremental compiler then turns
the application into ordinary TypeScript and React over the existing
runtime, query engine, workflow engine, SDK and HTTP layer. Verification
runs the application's own acceptance checks through its API and in
Chromium.

The pipeline is: spec, then IR, then type check, then dependency and
policy validation, then compile, then build, then independent
verification. Each stage reports structured diagnostics with a JSON
pointer into the spec, and a coding agent drives every stage through the
same CLI and MCP tools a person uses.

## Principles

The 3.0 principles still hold. Three more are added.

- **Nothing is converted silently.** Values of different types are not
  compared. An unknown value stays unknown through every operator
  (Kleene logic), and a figure computed from a value the caller may not
  see shows as unavailable, never as 0.
- **Generated code is the compiler's, and handwritten code is the
  person's.** The compiler owns `src/generated/`. A hand edit there stops
  the compile instead of being lost. `src/extensions/` is written once and
  never again, and typed contracts check the handwritten code against
  what the spec expects of it.
- **Runtime enforcement stays.** The checker reports early what the
  runtime would refuse. The runtime still decides every read, Action and
  approval as the caller.

## Slices

| Slice | What | ADRs | Evidence |
|---|---|---|---|
| 1 | The IR, its parser and its checker | [0079](adr/0079-an-application-is-compiled-from-a-typed-ir-of-five-primitives.md), [0080](adr/0080-the-checker-decides-before-any-code-exists.md), [0081](adr/0081-flows-lower-onto-the-workflow-engine.md) | `packages/compiler/test/check.test.ts` |
| 2 | Compilation to TypeScript and React, `@typesys/ui` and `@typesys/app`, build and verify | [0082](adr/0082-generated-code-is-ordinary-typescript-and-react-over-the-governed-sdk.md), [0083](adr/0083-generation-is-deterministic-and-incremental.md), [0084](adr/0084-an-application-is-verified-by-the-runtime-and-the-browser.md) | `packages/compiler/test/compile.test.ts` (API and Chromium checks, regeneration, hand-edit refusal, extension contracts) |
| 3 | The agent surface: `typesys app` CLI, nine MCP tools, catalog, explained diagnostics, semantic diff and impact | [0085](adr/0085-agents-compile-applications-through-the-same-diagnostics.md) | `packages/compiler/test/agent.test.ts` |
| 4 | Migration of a mission to an application | [0086](adr/0086-a-mission-migrates-to-an-application-and-says-what-changed.md) | `packages/compiler/test/migrate.test.ts` (sortie-readiness migrates with its 15 checks unchanged and passes 15 plus two screen checks) |
| 5 | Cold Chain Command, the reference application, over three services TypeSystem did not write | [0087](adr/0087-the-reference-application-is-compiled-over-three-services-typesystem-did-not-write.md) | `packages/cold-chain/test` (18 acceptance checks; a browser test of assessment, sign-off and quarantine) |
| 6 | Productivity measured against the engineering loop | none | [`evidence/compiler-productivity-2026-10-17.md`](evidence/compiler-productivity-2026-10-17.md) |
| 7 | Pressure test and its fixes | none | [`reviews/4-0-pressure-test.md`](reviews/4-0-pressure-test.md): 26 findings; 21 fixed, 4 kept with reasons, 1 did not reproduce; ten mutations in `tools/mutation/catalog.json` |

## What is not done

- **No paid model run.** The Cold Chain assessment runs on a
  deterministic stand-in model, and its stability figures are
  illustrative. A configured provider is a `typesys.llm.json` change
  (ADR-0074) and has not been exercised against this application.
- **No measured comparison with a person writing the same application.**
  The 3.0 evaluation's conventional arm (ADR-0073) needs a person, and it
  was not run. The measurement compares the compiler with the 3.0
  engineering loop only.
- **A custom design system's module is not checked to exist.** The
  checker validates the shape of `design.system`, and a missing module
  fails the build rather than the check.
- **The full mutation catalog was not run locally.** It runs on every
  pull request in CI (`.github/workflows/mutation.yml`). The ten new
  mutations were run locally on their own and all ten were killed.
- **The Studio model panel from 3.0 remains unstarted.**
- **Nothing is published to npm, and the code has had no external
  audit.**

## Delivery

The work lands as one commit per slice on `claude/typesystem-4-compiler-03fhfh`,
in pull request #21, merged to main on 2026-10-17.

## Continuation state

This section is kept current at each commit, so the work can be picked up
exactly where it stopped.

- **Done:** slices 1 to 7. The pressure test's findings are fixed or
  dispositioned. CI was green on every slice commit before the fixes.
- **Next, if wanted:**
  - Check that a custom design system's module exists.
  - Warn when a check step compares a value the initiator may be
    withheld. The measurement's seeded defect of that kind was found
    only by an acceptance check.
  - Run the Cold Chain assessment against a configured private provider
    on the owner's machine.
  - Run the conventional arm of the evaluation with a person.
