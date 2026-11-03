# 0108. Applications Run on the Deployment's Runtime

## Status

Accepted (2026-11-03). Implemented in `packages/app/src/server.ts`
(`HostedApplication`, `applicationApp`), `packages/compiler/src/emit/app.ts`
(the generated `server.ts` exports `application`), `packages/host/src/load.ts`
(`loadApplications`) and `packages/host/src/serve.ts` (`hostedWorkflows`,
`serve`). Proven by `packages/host/test/applications.test.ts`.

## Context

A compiled application (ADR-0082) ran its own process, building its own copy
of the host in-process, with a workflow journal a restart lost. ADR-0102
removed the restated rules, but each application still enforced and audited
in a runtime of its own, so "one path to the data" held for configuration,
not for the running system.

## Decision

A deployment lists `applications` by name and port. The generic server
imports each one's built `server.js` (from `TYPESYS_APPS_DIR`, an `apps`
directory beside the deployment, or this repository's `examples/apps`; or a
package specifier, never a path a deployment names), registers every flow on
one workflow engine over the deployment's journal (ADR-0106), and serves each
application's API and pages on its own port from the deployment's one
runtime. Each application's contract must be kept by the build, as a
declared consumer's is (ADR-0103); two applications may not name the same
model role. `createApp()` still builds the application alone for
development.

## Consequences

The recall response application passes all 16 hidden acceptance checks of
the challenge it was written for (docs/evidence/showcase-challenge) while
hosted, each against fresh services and a fresh server. A run an
application starts is read back through the deployment's own API, and its
decisions are on the deployment's audit chain. Applications are served on
separate ports, not paths, because a compiled client's routes and API base
are absolute.
