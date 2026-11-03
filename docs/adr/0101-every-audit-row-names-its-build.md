# 0101. Every Audit Row Names Its Build

## Status

Accepted (2026-11-02). Implemented in `packages/core/src/audit/audit-log.ts`
(`AuditEvent.build`), `packages/core/src/registry/registry.ts`
(`SemanticRegistryOptions.build`), `packages/core/src/registry/build-runtime.ts`,
`packages/registry-store-postgres` (migration `0007_audit_build.sql`) and
`packages/host/src/deployment.ts` (`buildIdOf`). Proven by
`packages/core/test/audit-build.test.ts`, the registry store contract and
`packages/host/test/host.test.ts`.

## Context

When a deployment is upgraded by replacing its document or its image, an
auditor reading a decision must know which rules and which model made it.
The audit log recorded who, what and the decision, but nothing of the build,
so a decision made before an upgrade could not be told from one made after.

## Decision

A build id is `sha256:` over the canonical deployment document and the
digest of every pack it installs. It hashes references, never the values
they resolve to: rotating a secret is not a new build; changing a pack, a
rule or a source mapping is, even when the deployment file is unchanged.

A `SemanticRegistry` given a build stamps it on every audit row it appends
that does not carry one. The Postgres store persists it in a nullable
`build` column (migration 0007), so rows written before the migration read
back without one. The generic server reports its build at `GET /version`
and as the MCP server's version.

## Consequences

Two replicas running different builds during a rolling restart write rows an
auditor can separate. A deployment built in code (`buildRuntime` without a
build) writes rows without one, exactly as before.
