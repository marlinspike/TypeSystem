# 0081. Flows Lower onto the Workflow Engine, and the Engine Grows Where It Must

## Status

Accepted (2026-10-16). Builds on ADR-0055 (SDK), ADR-0057 (workflows),
ADR-0072 (unavailable parts) and ADR-0074 (models). Implemented in
`packages/compiler/src/skeleton.ts`, `packages/workflow/src/engine.ts`,
`packages/sdk/src/transport.ts` and `packages/http/src/client.ts`. Proven
by `packages/workflow/test/named-models.test.ts`,
`packages/sdk/test/aggregate.test.ts` and `packages/http/test/spa.test.ts`.

## Context

The mandate for 4.0 is a compiler over the existing runtime, not a second
one. A flow (ADR-0079) therefore has to become an ordinary workflow that
the existing engine registers, runs, persists, audits and resumes. Four
things the compiled applications need were missing below the compiler:
one engine could use only one model, the SDK could not aggregate, an SDK
row dropped the runtime's report of unavailable parts, and the HTTP client
router could not serve a single-page application's deep links.

## Decision

**Lowering is one step to one engine step.** `lowerSteps` gives every
flow step the engine steps it reads (`needs`), in first-use order. A
`parallel` step is one engine step whose output holds each inner read by
name, because the engine already runs a step's work as one unit and
replays it as one. `forEach` is a read step with a bound. An `action` step
`needs` every approval before it, since a flow is ordered: this makes the
engine's AI-review rule (ADR-0057) see the approval between a proposal
and the Action that uses it. Steps with the same canonical `when` share
one condition function, because that rule compares conditions by
identity. `skeleton(flow)` builds the definition with placeholder
functions, so `validateWorkflow` checks the flow before any code is
generated; generated code (ADR-0082) builds the same structure.

**Named models.** `WorkflowEngine` takes `models: { [role]: AiModel }`
alongside its default `model`, and an AI step may name one with `model`.
An unknown name is an `unknown-model` diagnostic at registration, not a
failure in the middle of a run. A named model is subject to the same
release rules (ADR-0075) and audit as the default; a simulation answers
every AI step from its script whatever model it names.

**Aggregates through every transport.** `Transport.aggregate` is optional
on the interface, so a transport written before it still compiles, and
every transport shipped here (in process, MCP's `typesys_aggregate`, HTTP's
`POST /aggregate`) implements it. `Client.aggregate` throws a clear error
on a transport without it rather than guessing.

**Unavailable parts reach the row.** `toRow` sets `$unavailable` from the
runtime's `unavailable` list (ADR-0072) when it is not empty, so an
interface can show "maintenance history unavailable" instead of an empty
list.

**Deep links.** `clientRouter({ spa: true })` answers a GET that accepts
HTML, has no file extension and is not under `/api` with `index.html`.
Real files, missing files and API paths are unchanged.

## Consequences

- There is still one workflow engine, one audit trail and one durable
  store. A compiled flow is listed, started, approved, cancelled and
  resumed by the same HTTP routes and SDK calls as a handwritten one.
- Iterated or parallel Actions are not expressible, because the engine
  runs one Action per step with one compensation. Starting one run per
  object is the supported way, and the checker says so.
- Each addition is backward compatible: existing engines, transports and
  client routers behave exactly as before unless the new option is given.
