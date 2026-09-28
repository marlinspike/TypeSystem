# How to add a relationship and an Action

## A relationship

Declared inline on the *source* Type's schema, under `x-relationships`
(TypeScript) or `relationships` (YAML) — see
[`packages/domain-airforce/src/types/aircraft.ts`](../../packages/domain-airforce/src/types/aircraft.ts)
for the real pattern:

```ts
"x-relationships": {
  components: {
    target: "airforce.Component",          // the target Type's logical name
    cardinality: "one-to-many",              // "one-to-one" | "one-to-many" | "many-to-many"
    description: "Installed components on this aircraft.",
    resolution: {
      dataSourceId: "in-memory-airforce-repo",
      operation: "byForeignKey:aircraftId"   // see write-an-adapter.md for what this means
    }
  }
}
```

The same shape works in YAML under `relationships:` — see
[`add-a-type.md`](add-a-type.md).

**`resolution.operation` is a convention your adapter interprets, not
something the runtime understands.** The two conventions the shipped
adapters already implement:

- `byForeignKey:<field>` — scan the target type's records for
  `values[field] === sourceObjectId` (the common one-to-many case: a
  Component's own `aircraftId` field points back at its Aircraft).
- `byOwnField:<field>` — the source record's own `values[field]` *is* the
  target's object id (a one-to-one pointer stored on the source side).

Your own adapter can invent a different convention if neither fits — see
[`write-an-adapter.md`](write-an-adapter.md).

Navigate it at runtime with `runtime.getRelationship(typeName, objectId,
relationshipName, identity)`, or inline it into a query via `include:
[{relationship: "components"}]` (see
[`packages/core/src/model/query.ts`](../../packages/core/src/model/query.ts)).

## An Action

A plain `ActionDefinition` object, registered via
`registry.registerAction(...)` — see
[`packages/domain-airforce/src/actions/create-maintenance-work-order.ts`](../../packages/domain-airforce/src/actions/create-maintenance-work-order.ts)
for the real pattern:

```ts
export const CreateWidgetTicketAction: ActionDefinition = {
  id: "action-create-widget-ticket",
  name: "CreateWidgetTicket",
  description: "Opens a ticket against a Widget.",
  applicableTypes: ["fleet.Widget"],
  inputSchema: {
    type: "object",
    properties: { widgetId: { type: "string" }, note: { type: "string" } },
    required: ["widgetId", "note"]
  },
  outputSchema: { type: "object", properties: { id: { type: "string" } } },
  authorizationPolicy: "fleet.maintainer-only",   // see add-a-policy-rule.md
  preconditions: [
    { description: "The widget must exist", check: async (ctx) => { /* ... */ return true; } }
  ],
  implementation: { dataSourceId: "fleet-repo", operation: "createTicket" },
  sideEffects: "creates",       // "none" | "creates" | "mutates" | "external"
  idempotency: "none",           // "none" | "key" | "natural"
  auditRequired: true,
  version: "1.0.0"
};
```

**`inputSchema` is enforced, not just documented.** `invokeAction` checks
the input against it (after the policy check, before preconditions) and
throws `InvalidInputError` on a mismatch, so a precondition or adapter
never sees a malformed shape. It's also the MCP tool's advertised
schema. Add `additionalProperties: false` if extra fields should be
rejected rather than passed through.

`preconditions[].check` runs *before* the adapter's `executeAction` — use
it for business rules the runtime should enforce regardless of which
adapter implements the Action (existence checks, state-machine
transitions, cross-object validation).

Your adapter's `executeAction(action, input, ctx)` is where the actual
side effect happens — match on `action.implementation.operation`
(`"createTicket"` above) the same way
[`MockRestAdapter.executeAction`](../../packages/adapter-mock-rest/src/mock-rest-adapter.ts)
does.

**If this Action needs to survive being read back from
`@typesys/registry-store-postgres`**, give each precondition a
`bindingId` and supply the real `check` function via a `BindingRegistry`
at read time — same reasoning as a computed property's `binding`, see
[`add-a-type.md`](add-a-type.md) and
[ADR-0015](../adr/0015-postgres-registry-store.md).

## Verify it

Invoke it through the runtime, as an identity that should and shouldn't
be authorized — follow
[`packages/domain-airforce/test/create-maintenance-work-order-action.test.ts`](../../packages/domain-airforce/test/create-maintenance-work-order-action.test.ts):
assert an authorized call succeeds and is audited, an unauthorized call
throws `AuthorizationError` and is *also* audited (as a denial), and a
failed precondition throws `PreconditionFailedError`.
