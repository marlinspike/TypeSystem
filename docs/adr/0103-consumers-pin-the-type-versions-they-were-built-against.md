# 0103. Consumers Pin the Type Versions They Were Built Against

## Status

Accepted (2026-11-02). Finding H4 of the deployment design's pressure test
(no consumer version pinning). Implemented in
`packages/core/src/runtime/contract.ts`, `packages/core/src/runtime/runtime.ts`
(`requireType`, `actionMarkings`, `describeModel`), `packages/http`
(`TypeSystem-Contract` header, problem `contract-unsatisfied`, 412),
`packages/mcp-server/src/http-transport.ts`, `packages/sdk/src/transport.ts`
(`contract` option, `contractHeader`), `packages/app` and
`packages/compiler` (`contract.json`, `src/generated/contract.ts`), and
`packages/host` (`consumers` checked at boot). Proven by
`packages/core/test/contract.test.ts`,
`packages/domain-airforce/test/consumer-contract.test.ts`,
`packages/http/test/consumer-contract.test.ts`,
`packages/mcp-server/test/consumer-contract.test.ts` and
`packages/compiler/test/compile.test.ts`.

## Context

If deploying a new container is how a deployment is upgraded, every
application and agent on it is upgraded at the same moment, whether or not
it was written for the new model. A Type that moved to 2.0.0 would answer an
application built on 1.x in a shape it does not expect, and nothing would
say so.

## Decision

A consumer declares a contract: Type name to semver range. It travels with
every request, in a `TypeSystem-Contract` header
(`airforce.Aircraft@^1.0.0, airforce.WorkOrder@>=1.2.0 <2.0.0`) or as a
server's default for its own consumer (an application's server, an MCP
server for one agent). The runtime holds it for the request in
`AsyncLocalStorage` and checks it wherever it resolves a Type the request
reads, queries, follows or acts on: a contracted Type outside its range fails
the request, closed, with `ContractUnsatisfiedError` (HTTP 412,
`contract-unsatisfied`; an MCP tool error) before any source is read. The
refusal names the Type and the range, never the version registered. Types
the contract does not name are not checked.

`describeModel` under a contract adds whether the model keeps it, judged on
the Types that caller may see; a Type they may not see is reported without a
version, as one that does not exist would be.

The compiler writes each application's contract: every Type it reads,
filters, shows, follows a relationship to or acts on, at `^` the version it
compiled against, as `contract.json` (for a deployment and the upgrade
check) and `src/generated/contract.ts` (passed to its server). A deployment
lists its consumers, and the host refuses to start a build that breaks one.

## Consequences

A breaking model change cannot reach a pinned consumer silently: it is
refused at the upgrade check (ADR-0104), at boot when declared, and on every
request otherwise. The model still serves one version of each Type: a
consumer on an old major is refused, not served the old shape. Serving two
majors side by side is a later concern. MCP over stdio carries no headers,
so an agent on stdio is not pinned yet; an in-process client is, with
`runtimeTransport`'s `contract` option.
