# 0005. Actions as First-Class Governed Capabilities

## Status

Accepted

## Context

The mission brief is explicit: "Do not put all behavior directly onto
Types. Separate semantic objects from governed capabilities." An Aircraft
is a semantic object; `CreateWorkOrder` is an Action, with its own
authorization policy, preconditions, side-effect classification, and audit
requirement — properties a plain Type property or method never carries.

## Decision

Model an Action as `ActionDefinition`
(`packages/core/src/model/action.ts`): `id`, `name`, `description`,
`applicableTypes: string[]`, `inputSchema`/`outputSchema`
(`JsonSchema2020`), `authorizationPolicy: string`, `preconditions?:
PreconditionSpec[]`, `implementation: {dataSourceId, operation}`,
`sideEffects: "none" | "creates" | "mutates" | "external"`, `idempotency:
"none" | "key" | "natural"`, `auditRequired: boolean`, `version`,
`deprecated?`. Actions are registered independently of Types
(`registry.registerAction()`), linked only by name: a Type lists the
Actions applicable to it via `x-actions.actions`, and an `ActionDefinition`
lists the Types it applies to via `applicableTypes`.

`SemanticRuntime.invokeAction()` is the single enforcement point, always
executed in this order: policy check (`authorizationPolicy`, denying and
auditing before anything else runs) -> every `precondition.check()` in
sequence (first failure aborts with `PreconditionFailedError`) -> dispatch
to `adapter.executeAction()` on the adapter named by
`implementation.dataSourceId` -> a second audit event if `auditRequired`.
None of this enforcement lives in the adapter — an adapter's
`executeAction` only ever implements the side effect itself.

Actions map 1:1 onto MCP tools (`packages/mcp-server/src/tools.ts` turns
every registered `ActionDefinition` into a `Tool` using its own
`inputSchema`/`outputSchema` verbatim, plus an injected `authToken` field) —
see ADR-0012.

## Consequences

- An Action's `inputSchema` is validated the same way a Type's structural
  properties are (JSON Schema), so there is no second schema language for
  action input/output versus object properties.
- Preconditions run inside the Runtime, with access to `ctx.getAdapter()`
  for read-only lookups against any registered data source — the airforce
  slice's one precondition (the referenced `MaintenanceEvent` must exist)
  demonstrates this by calling the mock-REST adapter directly rather than
  duplicating that logic in application code.
- `sideEffects`/`idempotency` are declared but not yet enforced by the
  Runtime beyond documentation/introspection value (e.g. no automatic
  idempotency-key deduplication) — they exist so a consumer/agent can
  reason about an Action's blast radius before invoking it, which is the
  mission brief's actual requirement for this pass.
- Every Action invocation, successful or not, produces at least one audit
  event, because the policy-evaluation step itself always writes one.

## Alternatives Considered

- **Methods on the Type** (an Aircraft object exposing `createWorkOrder()`):
  rejected per the mission brief's explicit direction, and because it would
  make policy/precondition/audit enforcement inconsistent — easy to add a
  method that skips the checks a "real" Action gets, and impossible to list
  "every action applicable to this Type" without inspecting every method on
  every Type's implementation.
- **A single generic "mutate" endpoint** parameterized by operation name:
  rejected — it would erase the per-Action authorization policy,
  precondition set, and input/output schema that make an Action
  independently discoverable and independently governable (and
  independently exposable as a named MCP tool with its own schema, rather
  than one opaque tool with an untyped payload).
