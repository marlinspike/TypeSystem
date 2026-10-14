# Sortie confirmation

Written 2026-10-14, after the engineering loop (M4) was finished.

A sortie planner confirms a pilot for an aircraft before a sortie. The
aircraft comes from the fleet registry, its crew from the crew roster and
its parts from the parts depot: three services written by other people,
each with its own authorization. A maintainer may ask for the
confirmation, and so may a planner; only a planner may give it, never
for a confirmation they asked for themselves, and never for a pilot not
assigned to that aircraft. A viewer sees the fleet but not its mission
capability, its parts or its crew. A crew member's name is shown only to a
planner of that crew member's unit.

## What it runs on

The sortie model in `@typesys/sortie-readiness`:
`buildSortieHost({ rosterPii: true })` builds it and starts the three
services (in `examples/services/`), and `resolveSortieIdentity(token)`
turns a token into a person. Types are `ops.Aircraft`, `ops.CrewMember`
and `ops.Requisition`. Its policy rule `ops.sortie-signoff` says who may
sign off, and `ops.crew` who may ask.

## Names the application must use

- The workflow is `ops.ConfirmSortie`, with inputs `tailNumber` and
  `pilotId`.
- Its approval step is `plannerSignoff`.

## People

| Token | Who |
|---|---|
| `demo-planner-token` | Maj Chen, sortie planner, 388FW |
| `demo-maintainer-token` | TSgt Ruiz, maintainer, 388FW |
| `demo-viewer-token` | reads the fleet board |
| none | someone not signed in |
