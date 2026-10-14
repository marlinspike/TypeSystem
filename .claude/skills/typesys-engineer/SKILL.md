---
name: typesys-engineer
description: Build a governed application over a TypeSystem model from a requirement, using the mission spec and the plan, scaffold and verify loop (ADR-0071). Use when asked to build, change or fix a TypeSystem mission application.
---

# The TypeSystem engineering loop

TypeSystem decides who may see and do what. This loop lets you build an
application over that model and check it against the requirement *as each
person*, through the application's own API. Do not judge it by "it
compiles" or by tests you wrote yourself.

## 1. Write the mission spec

Create `mission.json` (format `typesys.mission/1`; the full shape is in
`packages/engineer/src/mission.ts`, and a complete example is
`examples/missions/component-replacement/mission.json`). It holds:

- `requirement`: the person's words, unchanged.
- `host`: the module that builds the runtime, and its token resolver.
- `callers`: one entry per kind of person in the requirement, with the
  token each signs in with. Include someone not signed in.
- `uses`: the Types and Actions the application needs.
- `workflow`: optional; read, check, approval and action steps. Every
  non-idempotent Action gets a `compensate`.
- `views`: optional tables.
- `acceptance`: one check per sentence of the requirement that says who
  may or may not see or do something.

Every "only", "not", "other than" and "cannot" in the requirement should
become a check that fails if it is violated (a `withheld` field, an
`offered: false`, an `admitted: false`, a `refused`).

## 2. Plan

```
npx typesys engineer plan mission.json --json
```

Fix every `error`, using its `at` (a path into the spec) and its `hint`.
Read each `warning`, and keep it only if the requirement asks for that
behaviour (for example `self-approval`). The `provided` section lists the
Types, relationships, Actions and workflows that already exist. Use them
rather than re-creating them.

## 3. Scaffold

```
npx typesys engineer scaffold mission.json --out <dir> --json
```

This writes `model.ts`, `workflow.ts`, `views.tsx`, `server.ts` and
`acceptance.test.ts`. They are ordinary code, and you may edit them.

## 4. Verify, then repair until it passes

```
npx typesys engineer verify <dir> --json
```

`ok` is true only when the plan, the build and every acceptance check
pass. For each diagnostic:

- `compile-error` at `file:line:col`: fix that line.
- `check-failed` at `acceptance/<n>`: read `observed` and `hint`.
  - If the application does something the requirement excludes, fix the
    application.
  - If the *model* releases something the requirement excludes, the fix
    belongs in the model's policy, not the application. Say so to the
    person; do not work around it in the UI.
  - Never change a check to make it pass unless the requirement says the
    check was wrong. Then say which check you changed and why.
- `startup-failed`: run `node <dir>/dist/server.js` yourself to see the
  error.

Verify again after every change. You are done when `verify` returns `ok:
true`. Report the checks that pass, and any warning you kept.

## As MCP tools

`typesys-engineer-mcp <root>` serves the same three operations over stdio:
`typesys_engineer_plan {mission}`, `typesys_engineer_scaffold {mission,
out}` and `typesys_engineer_verify {dir}`. Paths must be inside `<root>`.
They return the same JSON as `--json`.
