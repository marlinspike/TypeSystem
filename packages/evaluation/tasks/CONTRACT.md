# The application contract (every task, every arm)

Deliver one directory holding the application.

- It has a `package.json` whose `start` script serves the application over
  HTTP on `127.0.0.1`, on the port in the `PORT` environment variable. A
  `build` script, if present, runs first. Dependencies on `@typesys/*`
  packages resolve from the repository; add no other dependency.
- A caller signs in with `Authorization: Bearer <token>`. A request with
  no token, or a token the host does not know, is from someone not signed
  in.
- The governed API is served under `/api`:

| Request | Answer |
|---|---|
| `GET /api/me` | 200, whoever the caller is (used to tell the application is up) |
| `GET /api/objects/{type}/{id}` | 200 `{ "values": { … } }`; a field the caller may not read is absent from `values`; 403 when the caller may not read the object; 404 when it does not exist |
| `POST /api/query` with `{ "type", "filter"? }` | 200 `{ "items": [ { "objectId", "values" } ] }`, holding only what the caller may read; 403 when the caller may read no object of that Type at all; `filter` is `{ "property", "operator": "eq", "value" }` |
| `POST /api/workflows/{name}/runs` with `{ "input": { … } }` | 201 `{ "runId", "status", "waitingOn"?: { "step" } }`; `status` is `waiting-approval`, `completed` or `failed`; 403 when the caller may not start it |
| `POST /api/workflow-runs/{runId}/approvals/{step}` with `{ "approved": true }` | 200 `{ "status" }` when the caller may approve that step; 403 when not |
| `GET /api/workflow-runs/{runId}` | 200 `{ "status" }` to the person who started the run, and to anyone who may approve the step it is waiting on; 404 to anyone else |

A run that fails a check of its requirement answers 201 with status
`failed`; it never waits for approval.
