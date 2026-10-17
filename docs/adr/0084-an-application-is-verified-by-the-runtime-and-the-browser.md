# 0084. An Application Is Verified by the Runtime and the Browser, Independently of Its Code

## Status

Accepted (2026-10-16). Builds on ADR-0071 (the engineering loop's
verification) and ADR-0079 to ADR-0083. Implemented in
`packages/compiler/src/build.ts` and `packages/compiler/src/verify.ts`.
Proven by `packages/compiler/test/compile.test.ts`.

## Context

The checker (ADR-0080) decides early what can be decided from the
specification and the model. It cannot decide what the running
application shows: whether a refused caller sees a refusal, whether a
table a maintainer is meant to see has rows, whether a run waits at the
right approval. The engineering loop already answers those through the
API for missions (ADR-0071). A compiled application adds an interface,
so verification has to reach the browser too, and it has to be
independent of how the code came to be: generated, extended by hand, or
edited by an agent.

## Decision

**Three stages, each must pass.** `verifyApp(dir)` checks and compiles
the application, builds it, then runs every acceptance check. `ok` is
true only when all three pass.

**The build owns its outputs.** `buildApp` runs tsc over the whole
directory with the same owned flags the engineering loop uses (output to
`dist/`, strict, no incremental reuse, nothing of an earlier build kept),
then bundles `src/generated/app.tsx` with esbuild and copies the design
system's stylesheet. A tsc error in `contracts-check.ts` is reported as an
extension that drifted from its contract.

**Each check gets its own freshly started application**, on a free port,
ready only on the `typesys-engineer-ready <nonce> <url>` line, so no check
sees another's writes and a verdict does not depend on order. API checks
(`reads`, `refused`, `starts`, `approves`, `query`, `offered`) are the
engineering loop's own `runCheck`.

**Screen checks run in Chromium.** A `screen` check opens a page as a
caller (their token in session storage, as signing in leaves it), waits
until no node is loading twice in a row, then compares: nodes present or
absent by their stable `id` (`data-node`), text present or absent, and
how many object rows (`data-row`) a node shows. A page error fails the
check. A negative expectation therefore needs a positive signal from a
settled page, not a timeout.

## Consequences

A compiled application carries its own definition of done in
`app.json /acceptance`, decided by the runtime and the browser rather
than by the compiler that wrote it. The same checks run as the
application's own vitest suite (`src/generated/acceptance.test.ts`). The
squadron fixture's five checks pass in about four seconds; a screen check
that the screen does not meet fails with what it saw ("attention-table
shows 0 rows, fewer than 1").

Screen checks need a Chromium (`CHROME_PATH`, Playwright's browsers, or
the system's); without one a screen check fails with that reason rather
than passing.
