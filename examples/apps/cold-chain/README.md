# Cold Chain Command

A reference application compiled by `typesys app` (ADR-0087) from
[`app.json`](app.json) over three services TypeSystem did not write: a
shipment tracker, a temperature sensor hub and a pharmacy inventory
(`examples/services/`, each a plain Node server with its own data model
and credentials). The governed model over them is `@typesys/cold-chain`.

## What is in this directory

| Path | Who writes it |
|---|---|
| `app.json` | you: the whole application, as data (`typesys.app/1`) |
| `typesys.llm.json` | you: the model the AI steps ask, and its audience |
| `src/extensions/` | you: a stability rule, a value at risk, a gauge component, the stand-in model |
| `src/generated/`, `server.ts`, `index.html` | the compiler; never edit them |
| `typesys.lock.json` | the compiler: hashes that stop it overwriting a hand edit |

## Run it

From the repository root, after `npm install` and `npm run build`:

```sh
npx typesys app verify examples/apps/cold-chain   # compile, build, run all 18 checks
cd examples/apps/cold-chain && node dist/server.js # starts the three services too
```

Sign in with `demo-logistics-token` (a coordinator), `demo-qa-token` (a
pharmacist, the only one cleared to see contract prices),
`demo-auditor-token`, or `demo-carrier-token` (Northline's dispatch, who
sees only Northline's freight).

## The path it exists to show

On **Excursion review** for EX-301 the coordinator asks for an assessment:
the `assess` flow reads the excursion, the shipment, its readings and its
lots, and asks the model, which is given only what its audience may read.
**Request disposition** starts `disposition`, which waits for a
pharmacist. On **Cold chain command** the pharmacist sees the request
with the model's recommendation and approves it; the excursion is closed
in the sensor hub and both lots on the shipment are quarantined in the
inventory. If the quarantine fails, the excursion is reopened.

The stability figures in `src/extensions/stability.ts` are illustrative,
and the model is a deterministic stand-in (`src/extensions/server.ts`); a
deployment replaces both.
