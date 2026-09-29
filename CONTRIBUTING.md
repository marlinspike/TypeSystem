# Contributing to TypeS

Thanks for considering a contribution. This is a reference implementation
with an unusually strong emphasis on *why* things are shaped the way they
are, so the most useful thing you can do before writing code is read the
relevant [ADR](docs/adr/) — and if you're changing a hard-to-reverse
decision, add or amend one.

## Ground rules, in one place

These are the conventions the codebase already holds itself to (they also
appear in [`llms.txt`](llms.txt) for coding agents):

- **One governed boundary.** Validate caller input and enforce policy at
  `SemanticRuntime`, never in a transport. A new public runtime method that
  accepts caller JSON goes through `InputValidator` and the policy engine so
  that applications, the demo HTTP API, and MCP agents all get identical
  checks. Don't re-implement either in `mcp-server` or `demo-web`.
- **Domains are packages you add, never core you edit.** A new domain is a
  new `packages/domain-*` (see
  [`docs/developer-guide/adding-a-domain.md`](docs/developer-guide/adding-a-domain.md));
  `domain-hospital` was added with zero changes to `packages/core` or
  `packages/mcp-server`, and that property is worth preserving.
- **Adapter calls share one budget per request.** Get adapters through
  `getAdapter` / `ctx.getAdapter`, never off `this.adapters` directly, or
  the call escapes the concurrency budget (see ADR-0019/0025).
- **Shared state goes behind an interface.** Anything that must agree across
  replicas (cache, rate limits, registry, audit) sits behind
  `Cache`/`RateLimiter`/`RegistryStore`. Don't add process-local state that
  changes cross-instance behaviour without a shared implementation and a
  multi-instance test.
- **Queries are bounded and paged by default.** New query capabilities must
  respect `QueryLimits` and fail closed under property-level policy, the way
  filtering already does.

## Development setup

```bash
npm install            # workspaces install
npm run lint:install   # installs the isolated ESLint toolchain (see below)
```

The linter lives in [`tools/eslint/`](tools/eslint/) **on purpose**:
`typescript-eslint` needs TypeScript's JS API, which the TypeScript 7 used
for the build doesn't ship, so the linter pins its own TypeScript 5.9. Don't
move ESLint into the root `devDependencies` — npm refuses the peer-dependency
conflict. If you add a new top-level TypeScript folder, add it to
`tools/eslint/tsconfig.lint.json`'s `include`.

## The check gate (run before opening a PR)

CI (`.github/workflows/ci.yml`) runs all of this on every push and PR, so
save yourself a round trip:

```bash
npm run build && npm test && npm run lint && npm run typecheck
```

If you touched `mcp-server` or `SemanticRuntime`, also run the real MCP
smoke tests:

```bash
npm run smoke:mcp        # real stdio subprocess, discover-to-invoke
npm run smoke:mcp-http   # the same over the HTTP transport
```

Postgres/Redis-backed tests **skip cleanly** without `DATABASE_URL` /
`REDIS_URL`. To run them locally, point those at a real instance; CI runs a
second job with Postgres and Redis service containers plus the multi-process
`npm run load-test`.

## Changesets

Any **user-visible behaviour change** needs a changeset so the affected
packages get versioned correctly across the dependency graph:

```bash
npm run changeset
```

Pick the packages you changed and a semver bump, and write a one-line
summary a consumer would understand. Docs-only, test-only, or internal
refactors that change no public behaviour don't need one. Where relevant,
also update [`docs/completeness.md`](docs/completeness.md) and, if you closed
one, [`docs/PRODUCTION-READINESS.md`](docs/PRODUCTION-READINESS.md).

## ADRs

Add an ADR under [`docs/adr/`](docs/adr/) for any major or hard-to-reverse
decision — a new interface, a new cross-cutting mechanism, a change to how
policy/audit/identity work. Follow the existing format (Status / Context /
Decision / Consequences / Alternatives Considered), number it sequentially,
name the alternatives you actually rejected and why, and add a row to the
table in [`docs/README.md`](docs/README.md). A new decision written ahead of
its implementation may start as `Proposed` and flip to `Accepted` when the
code lands.

## Commits and pull requests

- Keep a PR to one coherent change; a large feature is easier to review as a
  sequence of green commits than one enormous diff.
- Every commit should build and pass tests on its own.
- Explain **why** in the PR description, and link the ADR(s) the change
  implements or amends.
- Be kind and assume good faith — see [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE) that covers this project.
