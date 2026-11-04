# 0115. YAML Types Are Built Into a Pack

## Status

Accepted (2026-11-03). Implemented in `packages/cli/src/bin.ts`
(`typesys pack build`) and `packages/cli/src/yaml-loader.ts`
(`loadYamlTypesFromDirectory`). Proven by `packages/cli/test/pack-build.test.ts`.

## Context

`typesys init <dir>` without `--from` scaffolds YAML Types, and `typesys
validate` registers them, but a deployment lists packs, and packs were
built only from TypeScript manifests (`buildPack`). A Type written by hand
could not be served by the generic host without writing code.

## Decision

`typesys pack build <dir> --name <pack> --version <semver> --out <file>`
registers the directory as `validate` does, then builds a pack of its
Types, each read from one data source: `--source <id>` (default
`<pack>-db`), `--source-kind postgres|http` (default `postgres`), or
`--source none` for Types another pack or an extension maps. A pack whose
Types extend core's or use its traits requires `core ^1.0.0`. It prints the
rules the deployment must supply.

## Consequences

A hand-written Type reaches a deployment the same way an onboarded one
does: a pack, a declared source, and rules as data. Computed values still
need their bindings from an extension, as for any pack (ADR-0059).
