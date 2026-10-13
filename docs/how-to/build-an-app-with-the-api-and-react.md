# How to build an app with the API and React

`@typesys/http` serves the runtime as a governed REST API, and
`@typesys/react` gives a React app typed, headless hooks over the same SDK
client an agent or a server uses
([ADR-0058](../adr/0058-governed-http-api-and-headless-react-bindings.md)).
Neither decides access: every call is the runtime's, for the caller the
bearer token names.

## 1. Serve the API

```ts
import { createApiApp } from "@typesys/http";
import { createOidcIdentityResolver } from "@typesys/auth-oidc";

const app = createApiApp({
  backend: { registry, runtime },                 // what buildRuntime returns
  identityResolver: createOidcIdentityResolver({ issuer, audience }),
  workflows,                                      // optional: a WorkflowEngine (ADR-0057)
  allowedHosts: ["typesys.example.mil"],          // default: this machine only
  onError: (err) => logger.error(err)             // 500s; the caller only sees "Internal error"
});
app.listen(8080);
```

The API is under `/api`, with `/healthz` and `/readyz` beside it.
`GET /api/openapi.json` is the contract, generated from the model: each
Action's request is typed by its input schema and carries
`x-typesys-side-effects` and `x-typesys-idempotency`. To mount the routes
in an app you already have, use `createApiRouter(opts)` and put your own
Host and Origin checks (or `originGuard`) in front of it.

The API sends no CORS headers. Serve the browser app from the same origin,
or put a proxy that owns CORS in front of both.

## 2. Call it with the typed SDK

```ts
import { createClient, httpTransport, ApiError } from "@typesys/sdk";
import type { AirforceModel } from "./airforce-model";   // generated, see use-the-typed-sdk.md

const af = createClient<AirforceModel>(httpTransport({ baseUrl: "/api", token: () => session.accessToken() }));

try {
  await af.action("UpdateWorkOrderStatus").invoke({ workOrderId: "WO-1", status: "closed" });
} catch (err) {
  if (err instanceof ApiError && err.code === "forbidden") show(err.reason);   // the policy's own words
}
```

Refusals arrive as RFC 9457 problems with a stable `code`: `forbidden`,
`not-found`, `invalid-input` (with the schema's `errors`),
`precondition-failed`, `rate-limited`, `conflict`, `workflow-diverged`,
`unavailable`, `internal`. Branch on `code`, not on the message.

## 3. Bind it to React

```ts
import { createTypeSHooks, columnsFor, formFields, coerceForm } from "@typesys/react";

export const { TypeSProvider, useQuery, useObject, useActions, useAction } = createTypeSHooks<AirforceModel>();

// <TypeSProvider client={af}><Fleet /></TypeSProvider>

function Fleet() {
  const list = useQuery((c) => c.from("airforce.Aircraft").select("tailNumber", "readinessStatus").orderBy("tailNumber").limit(25), []);
  if (list.status === "error") return <p>{list.error.message}</p>;
  if (list.status !== "success") return <p>Loading</p>;
  return (
    <>
      {list.data.items.map((a) => <Row key={a.$id} aircraft={a} />)}
      {list.data.nextCursor && <button onClick={list.loadMore}>More</button>}
    </>
  );
}
```

Rows are typed by the select, and a value the runtime withheld is simply
absent: the same component shows a viewer fewer cells than a maintainer.
Do not hide controls by role. Ask the runtime:

```ts
const actions = useActions("airforce.MaintenanceEvent", eventId);   // each with `authorized`
const close = useAction("UpdateWorkOrderStatus");
await close.preview(input);   // close.previewed.data: authorized, blockers, wouldExecute; nothing runs
await close.invoke(input);    // close.invoked: the result, or the refusal as an error
```

## 4. Derive forms and tables from the model

```ts
const model = await (await fetch("/api/model")).json();
const action = model.actions.find((a) => a.name === "UpdateWorkOrderStatus");
const fields = formFields(action);
// [{ name: "workOrderId", label: "Work order id", kind: "text", required: true, objectOf: "airforce.WorkOrder" },
//  { name: "status", label: "Status", kind: "select", required: true, options: ["open", "in-progress", "closed"] }]

const { value, errors } = coerceForm(fields, formValues);   // strings from controls into the Action's input
if (Object.keys(errors).length === 0) await close.preview(value);

const columns = columnsFor(model.types.find((t) => t.name === "airforce.Aircraft"), ["tailNumber", "readinessStatus"]);
// readinessStatus is computed: `sortable: false`, since the runtime refuses that sort.
```

`formFields` covers top-level inputs; anything nested is a `json` field.
It does not validate: `preview` returns every blocker, the schema's
included, without executing anything.
