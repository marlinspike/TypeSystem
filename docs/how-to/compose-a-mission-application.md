# How to compose a mission application

The squadron readiness application in `packages/mission-readiness` is a
worked example of an application built on TypeSys
([ADR-0063](../adr/0063-a-mission-application-composed-and-by-hand.md)):
a board of aircraft that need attention, each aircraft's maintenance
history, opening and updating work orders, and grounding an aircraft for
repair with a lead's approval. The same application is also written by
hand, the way the runtime had to be used before this work, so the two can
be compared.

## 1. Run both

```sh
npm install
npm run build      # also bundles both clients
npm run mission    # composed on :4500, hand-written on :4501
```

Each header offers a maintainer (SSgt Rivera), a lead (MSgt Okafor) and a
viewer. These are demonstration tokens (ADR-0050), never for a deployment.

## 2. The server is the governed API

```ts
import { clientRouter, createApiApp } from "@typesys/http";

const app = createApiApp({ backend, identityResolver, workflows });
app.use(clientRouter({ dir: "dist/public", config: { signIns } }));
```

That is the whole server (`src/composed/server.ts`). `createApiApp` serves
queries, Actions, previews and workflows at `/api`, each decided by the
runtime or the workflow engine for the caller. `clientRouter` serves the
bundled client under a Content Security Policy that lets the page load
only its own script, style and API. `config` is public: put nothing in it
the page's visitors should not have.

## 3. The client asks; it never decides

```tsx
const { TypeSysProvider, useQuery, useActions, useAction } = createTypeSysHooks<AirforceModel>();

// A typed query, filtered on a computed property.
const board = useQuery(
  (af) => af.from("airforce.Aircraft").where((a) => a.needsAttention.eq(true))
    .select("tailNumber", "model", "readinessStatus", "deploymentLocation").orderBy("tailNumber").limit(50),
  []
);

// Offer a control only when the runtime says this person may use it on this object.
const actions = useActions("airforce.WorkOrder", order.$id);
const allowed = dataOf(actions)?.some((a) => a.name === "UpdateWorkOrderStatus" && a.authorized);
```

Before an Action with consequences, preview it as the invocation would be
decided and invoke only if it would run:

```ts
const preview = await client.action("CreateMaintenanceWorkOrder").preview(input);
if (preview.wouldExecute) await client.action("CreateMaintenanceWorkOrder").invoke(input);
```

A process that needs another person goes through a governed workflow:

```ts
const workflows = httpWorkflows({ baseUrl: "/api", token });
await workflows.start("airforce.GroundForRepair", { aircraftId: tail, assignTo: "SSgt Rivera" });
// A lead, elsewhere:
for (const a of await workflows.approvals()) await workflows.approve(a.runId, a.step, { approved: true });
```

Who may start it, who may approve it (never the person who asked), and
what the model's proposal must satisfy are in the workflow's definition
(`groundForRepair` in `@typesys/domain-airforce`), not in the application.

## 4. Type against the model, not beside it

Write lists of allowed values with the model's types, so a misspelling is
a compile error rather than a refusal at run time:

```ts
type WorkOrder = Row<AirforceModel, "airforce.WorkOrder">;
const STATUSES: readonly NonNullable<WorkOrder["status"]>[] = ["open", "in-progress", "closed"];
```

## 5. Check it in a browser

`packages/mission-readiness/test/scenario.ts` drives either version as a
viewer, a maintainer and a lead, and returns what each saw; the test
expects the same for both. Copy it for your own application: the scenario
states the policy as people meet it, which is what a reviewer wants to
check.
