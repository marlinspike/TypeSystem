# The engineering loop, 2026-10-14 (ADR-0071)

The CLI run on `examples/missions/component-replacement`. To regenerate it, run `npm install && npx tsc -b`, then the commands below. The same flow is asserted by `packages/engineer/test/loop.test.ts` on every CI run.

## Plan

```
$ npx typesys engineer plan examples/missions/component-replacement/mission.json
OK — component-replacement
  provides Type   airforce.Aircraft (described to maintainer, lead, viewer, anonymous)
  provides Type   airforce.Component (described to maintainer, lead, viewer, anonymous)
  provides Type   airforce.MaintenanceEvent (described to maintainer, lead, viewer, anonymous)
  provides relationship airforce.Aircraft.components → airforce.Component (one-to-many)
  provides relationship airforce.Aircraft.maintenance → airforce.MaintenanceEvent (one-to-many)
  provides relationship airforce.MaintenanceEvent.workOrder → airforce.WorkOrder (one-to-one)
  provides Action CreateMaintenanceWorkOrder (described to maintainer, lead, viewer, anonymous)
  provides Action UpdateWorkOrderStatus (described to maintainer, lead, viewer, anonymous)
  provides workflow airforce.GroundForRepair 1.0.0
  creates  mission.json: the spec, as verified
  creates  model.ts: the typed client model (@typesys/sdk) for 3 Types
  creates  workflow.ts: airforce.ReplaceComponent: component → event → sameAircraft → leadApproval → openWorkOrder
  creates  views.tsx: ComponentList, FleetList
  creates  server.ts: the governed HTTP API over the host, with the workflow registered
  creates  acceptance.test.ts: 12 checks, run through the application's API as each caller
```

## Scaffold and verify

```
$ npx typesys engineer scaffold examples/missions/component-replacement/mission.json --out app
Wrote 8 files to app; next: typesys engineer verify app
$ npx typesys engineer verify app
OK — component-replacement: plan ok, build ok, checks ok
  pass  viewer-reads-components
  pass  viewer-lacks-maintenance-status
  pass  anonymous-sees-nothing
  pass  viewer-lists-an-aircrafts-components
  pass  maintainer-offered-work-order
  pass  viewer-not-offered-work-order
  pass  maintainer-requests-replacement
  pass  mismatched-aircraft-fails
  pass  viewer-cannot-request
  pass  lead-approves-and-work-order-opens
  pass  maintainer-cannot-approve
  pass  lead-cannot-approve-own-request
```

## A seeded defect: the approval admits the requester

An agent writes `allowSelfApproval: true` into the approval step of `app/workflow.ts`:

```
$ npx typesys engineer verify app
FAILED — component-replacement: plan ok, build ok, checks FAILED
  pass  viewer-reads-components
  pass  viewer-lacks-maintenance-status
  pass  anonymous-sees-nothing
  pass  viewer-lists-an-aircrafts-components
  pass  maintainer-offered-work-order
  pass  viewer-not-offered-work-order
  pass  maintainer-requests-replacement
  pass  mismatched-aircraft-fails
  pass  viewer-cannot-request
  pass  lead-approves-and-work-order-opens
  pass  maintainer-cannot-approve
  FAIL  lead-cannot-approve-own-request
  error   check-failed at acceptance/11: "lead-cannot-approve-own-request" failed: lead was admitted to approve leadApproval (the approval admits someone the requirement excludes: check its policy and allowSelfApproval)
(exit 1)
```

The diagnostic names the check and points at `allowSelfApproval`. With that line removed:

```
$ npx typesys engineer verify app
OK — component-replacement: plan ok, build ok, checks ok
```
