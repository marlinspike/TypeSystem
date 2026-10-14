# Component replacement

Written 2026-10-14, before the engineering loop (M4) was finished.

When a component on an aircraft needs replacing, a maintainer requests the
replacement against one of that aircraft's maintenance events. A
maintenance lead other than the requester approves it, and only then is a
work order opened and assigned; if the work order cannot finish, it is
closed again. Viewers can see the fleet's components and aircraft without
their maintenance status, and cannot request a replacement or open a work
order. Someone not signed in sees nothing.

## What it runs on

The airforce model in `@typesys/domain-airforce`: `buildAirforceTestbed()`
builds it, and `resolveDemoIdentity(token)` turns a token into a person.
Types are `airforce.Aircraft`, `airforce.Component`,
`airforce.MaintenanceEvent` and `airforce.WorkOrder`; the Actions are
`CreateMaintenanceWorkOrder` and `UpdateWorkOrderStatus`. Its policy rules
`airforce.maintainer-only` and `airforce.maintenance-lead` say who is a
maintainer and who is a lead.

## Names the application must use

- The workflow is `airforce.ReplaceComponent`, with inputs `componentId`,
  `maintenanceEventId` and `assignTo` (the work order's assignee).
- Its approval step is `leadApproval`.
- A request whose component and maintenance event are on different
  aircraft fails.

## People

| Token | Who |
|---|---|
| `demo-maintainer-token` | SSgt Rivera, a maintainer |
| `demo-lead-token` | MSgt Okafor, a maintenance lead |
| `demo-viewer-token` | a read-only viewer |
| none | someone not signed in |
