# 0086. A Mission Migrates to an Application, and Says What Changed

## Status

Accepted (2026-10-17). Builds on ADR-0071 (missions) and ADR-0079 to
ADR-0085. Implemented in `packages/compiler/src/migrate.ts`, as
`typesys app migrate` and the `typesys_app_migrate` MCP tool. Proven by
`packages/compiler/test/migrate.test.ts`.

## Context

3.0 applications are written as `typesys.mission/1` specs: one workflow,
tables of one Type each, and acceptance checks the runtime decides. 4.0
compiles `typesys.app/1`, which says everything a mission says and more.
A team with missions should not rewrite them by hand, and should not have
to trust that a translation kept their meaning.

## Decision

**`missionToApp` translates, and the mission's own checks prove it.** The
host, callers and requirement are copied; every acceptance check is
copied unchanged, so the application must pass exactly what the mission
passed; the workflow becomes one flow, step for step under the same
names, so a check that names a step (`waitingOn`, `failsAt`, `step`)
still finds it. A mission value and an expression mean the same thing
(`$input.x`, `$step.x`, `$output.x` are references in both, and a mission
refuses any other string starting with `$`), so values are copied as they
are. An input that a read step looks up by id becomes `objectOf` that
Type.

**Nothing changes silently.** Every difference is a `mission-translation`
note (severity info) at its place in the mission:

- a check step becomes `{ "eq": [a, b] }`, which the checker types, so
  comparing values of different types is now a compile error where the
  mission failed every run;
- views become tables on one page, each with a stable node id
  (`FleetBoard` → `fleet-board-table`);
- the workflow gains a form to start it and an approval queue, which the
  mission did not have;
- a Type or Action in `uses` that nothing in the application names is
  listed, because an application has no `uses`: it reads what its pages
  and flows name.

An invalid mission is refused with the engineer's own diagnostics, as
JSON Pointers. `migrate` writes only `app.json`, never replaces one
without `--force`, and rewrites a host module given as a path so it still
names the same file from the new directory.

## Consequences

`examples/missions/sortie-readiness` migrates, compiles, builds and
passes all 15 of its original checks, plus two screen checks: a planner
sees the fleet table with every row the paged registry returns and a
crew member's name, and a viewer sees the crew table refused and no name.
The translation does not invent checks for what it added; a team that
keeps the form and queue should add screen checks for them.
