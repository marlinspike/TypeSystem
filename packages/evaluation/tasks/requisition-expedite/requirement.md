# Requisition expedite

Written 2026-10-14, after the engineering loop (M4) was finished, for this
evaluation; no application for it existed before.

A maintainer asks to expedite a parts requisition that is still awaiting
shipment, giving a reason. A planner may ask too. A planner approves the
request, though never one they asked for themselves; a maintainer cannot
approve one, their own or anyone's. A requisition already in
transit or issued cannot be expedited: the request fails. A viewer cannot
ask, and reads no requisition. Someone not signed in sees nothing.

## What it runs on

The sortie model in `@typesys/sortie-readiness`: `buildSortieHost()` builds
it and starts the three services (in `examples/services/`), and
`resolveSortieIdentity(token)` turns a token into a person. The
requisitions are `ops.Requisition`, from the parts depot; their `status`
is `awaiting`, `in-transit` or `issued`. Its policy rule `ops.maintenance`
says who works on parts, and `ops.sortie-signoff` who is a planner.

## Names the application must use

- The workflow is `ops.ExpediteRequisition`, with inputs `requisitionId`
  and `reason`.
- Its approval step is `plannerApproval`.

## People

| Token | Who |
|---|---|
| `demo-planner-token` | Maj Chen, sortie planner, 388FW |
| `demo-maintainer-token` | TSgt Ruiz, maintainer, 388FW |
| `demo-viewer-token` | reads the fleet board |
| none | someone not signed in |
