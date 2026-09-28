# 0020. Publish Infrastructure, Not a Publish

## Status

Accepted

## Context

Every `@typesys/*` package has a real `name`/`version`/`exports` today,
but none of the surrounding infrastructure a package needs before a real
`npm install @typesys/core` from outside this repo could ever work
existed: no `description`/`license`/`repository`/`keywords`/`files`
allowlist, no LICENSE file, no coordinated versioning across packages
that depend on each other, and no CI step that could cut a release even
if all of that existed.

Building that infrastructure is separable from actually publishing.
Claiming the `@typesys` scope on the public npm registry is a one-way
action — someone else could claim it first if this repo ever needs it
and it's still free, and once claimed, this repo's own automation
becomes the thing the world depends on for that name. That's a decision
for whoever owns this repository to make deliberately, not something
that should happen as a side effect of "making the repo more complete."
So this pass builds every piece of infrastructure a real release would
need, wires it into CI, and deliberately stops one step short of ever
executing `npm publish` for real — see Decision.

## Decision

### Package metadata

Every publishable package (`packages/*/package.json`) now has:

- `description`, `license: "MIT"` (root `LICENSE` file, MIT, matches),
  `repository` (with a `directory` pointing at that package inside the
  monorepo), `homepage`, `keywords`.
- `files: ["dist"]` — only compiled output ships; `src`/`test` never do.
  `adapter-postgres`/`registry-store-postgres` additionally ship
  `migrations` — their compiled `runMigrations()` resolves
  `path.resolve(__dirname, "../migrations")` at runtime, i.e. the raw
  `.sql` files next to (not inside) `dist`; a real `npm pack --dry-run`
  run while building this ADR caught that `files: ["dist"]` alone would
  have silently shipped a package whose one runtime file-read always
  fails post-install — worth calling out because it's exactly the class
  of bug "the code is tested" never catches, only actually building the
  tarball does.
- `publishConfig: { "access": "public" }` — required for a scoped
  package (`@typesys/*`) to publish publicly rather than defaulting to
  npm's private-scope behavior, which would fail outright on a free npm
  account.

`@typesys/demo-web` is the one exception: `"private": true`, no
`publishConfig`. It's a runnable demo app (`npm run demo`), not a
library anyone would `npm install` — publishing it would be actively
wrong, not just unnecessary.

### Changesets for cross-package versioning

[`@changesets/cli`](https://github.com/changesets/changesets)
(`.changeset/config.json`) — the standard tool for "a monorepo where
packages depend on each other and need coordinated version bumps and
changelogs," rather than something built by hand for this repo.
`updateInternalDependencies: "patch"` means bumping `@typesys/core`
automatically bumps every package that depends on it (verified: adding
one real changeset for this session's `core`/`adapter-postgres`/
`auth-oidc`/`mcp-server` changes correctly proposed patch bumps for
`adapter-in-memory`, `adapter-mock-rest`, `cli`, `domain-airforce`, and
`registry-store-postgres` too, purely from their `@typesys/core`
dependency — see `npx changeset status`). `@typesys/demo-web` is in
`ignore` — never versioned or published by changesets, consistent with
`private: true`.

### A gated release workflow

`.github/workflows/release.yml`, on every push to `main`: builds and
runs the full test suite exactly like `ci.yml`, then checks whether an
`NPM_TOKEN` repository secret is configured. If not — the case for this
repository, today — the workflow logs that it's skipping and stops
there; nothing fails, nothing attempts to publish. If a maintainer ever
adds a real `NPM_TOKEN`, the same workflow starts doing what
[`changesets/action`](https://github.com/changesets/action) does on
every repo that uses it: open/update a "Version Packages" PR from
whatever changesets have accumulated, and once that PR is merged,
actually run `npm run release` (which runs `changeset publish`) to push
real versions to npm.

### What was deliberately not run

`npx changeset version` (which would rewrite every affected package.json
version and write CHANGELOG.md files) and `npm publish`/`changeset
publish` (which would push to the real npm registry) were both
deliberately not run as part of building this infrastructure. A real
changeset (`.changeset/real-adapter-real-auth-and-runtime-bounds.md`)
was added and verified via `npx changeset status` to prove the pipeline
actually works end-to-end — that step stops short of mutating version
numbers or touching the real registry, both real, mostly-irreversible
actions that belong to whoever decides this project is ready to ship a
real release, not to whichever pass happened to build the tooling.

## Consequences

- This repository can go from "no publish story" to "someone runs
  `npx changeset version`, reviews the diff, and merges it, then a
  maintainer adds `NPM_TOKEN` as a repository secret" without any further
  code changes — the entire path is built and already proven to parse
  correctly against this exact package graph.
- Until `NPM_TOKEN` is added, `release.yml` runs on every push to `main`
  and always exits successfully having done nothing beyond build+test —
  visible in Actions history, never a silent no-op and never a failing
  red build.
- The pending changeset in `.changeset/` will describe this session's
  real work whenever a maintainer does decide to version; it is not
  itself consumed by anything until `changeset version` runs.

## Alternatives Considered

- **Hand-rolled version-bump script instead of changesets**: rejected —
  changesets already solves the two hard parts (per-package changelogs,
  and propagating an internal-dependency bump through the whole
  dependency graph) correctly; a hand-rolled equivalent would either skip
  one of those or re-implement changesets by hand for no benefit.
- **Publishing right now, since every package genuinely works and is
  tested**: rejected — see Context. Working and tested is necessary but
  not sufficient; claiming a public package name is this project's call
  to make once, deliberately, not a byproduct of a documentation/
  infrastructure pass.
- **Leaving `access` unset and letting a maintainer figure out
  `publishConfig` later**: rejected — an unscoped-defaulting publish
  attempt against a scoped package name fails outright on npm's free
  tier; better to have the correct, inert configuration in place now than
  to leave a guaranteed first-publish failure for whoever eventually
  flips this on.
- **Skip the CI-integrated gate and just document "add NPM_TOKEN and run
  `npm publish` by hand" in a README**: rejected — that reintroduces
  exactly the two problems changesets/CI integration solves (manual,
  error-prone version bumps; no coordinated changelog), and defers all
  the actual release engineering to whoever tries to ship first. Building
  the real, gated pipeline now — inert until a secret is added — costs
  nothing today and is strictly more useful later than a paragraph of
  instructions.
