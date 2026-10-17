# 0087. The Reference Application Is Compiled Over Three Services TypeSystem Did Not Write

## Status

Accepted (2026-10-17). Builds on ADR-0072 (independent services), ADR-0076
(Actions over HTTP) and ADR-0079 to ADR-0086. Implemented in
`examples/services/{shipment-tracker,sensor-hub,pharmacy-inventory}`,
`packages/cold-chain` and `examples/apps/cold-chain`. Proven by
`packages/cold-chain/test/host.test.ts` and `test/app.test.ts`.

## Context

The mandate asks for a reference application over multiple independent
systems, in a new scenario, with rich interface, AI, approvals and
Actions, tested in a browser. The squadron fixture exercises the compiler
over one in-memory domain; it cannot show what happens when the systems
disagree about names, codes, paging and credentials, or when a write lands
in two of them.

## Decision

**A pharmaceutical cold chain.** Three plain Node services, each with its
own data model and authorization, none importing TypeSystem:

- the **shipment tracker** (an API key; a carrier's key sees only its
  freight; cursor paging three a page; two-letter state codes, SCAC
  carrier codes, a nested GPS fix);
- the **sensor hub** (OAuth 2.0 client credentials with a read scope and
  a write scope; readings paged by cursor, 24 a page; excursion bands in
  capitals; a disposition endpoint that refuses a closed excursion with
  409, and a reopen endpoint);
- the **pharmacy inventory** (a key per client, one read-only; facilities
  as a bare array with coordinates as a pair; lots with nested storage
  ranges and three-letter status codes; quarantine and release per lot
  or per shipment).

`@typesys/cold-chain` maps them onto five Types (Site, Shipment, Reading,
Excursion, Lot) with optional cross-service relationships, six Actions
over two services, a commercial classification scheme (a lot's unit cost
is CONFIDENTIAL), a carrier's row-level rule, and a model audience that
may read telemetry and lots but is cleared only INTERNAL.

**The application is one `app.json` and four small extensions.** Four
pages (a command dashboard with KPIs, a map, an excursion table, an
approval queue and a shipment table; a shipment page with a temperature
chart and its permitted band, a timeline, a relationship graph and the
lots across systems; an excursion review with a handwritten gauge, the
model's assessment and the run's progress; a lots page with an aggregate,
grouping, filters and confirmed Actions). Two flows: `assess` reads and
asks the model, and changes nothing; `disposition` adds a pharmacist's
sign-off, then closes the excursion in the sensor hub (reopened as
compensation) and, unless the lots are released, quarantines them in the
inventory. The extensions are a stability rule (`budgetMinutes`), a value
at risk that is unknown rather than understated when a price is withheld,
a gauge component, and the stand-in model.

**What is committed is what the compiler generates.** The generated
sources are in the repository, and a test fails if compiling `app.json`
would change any of them.

## Consequences

`packages/cold-chain/test/app.test.ts` checks the committed output is
current, runs all 18 acceptance checks (14 through the API, 4 in
Chromium), and in a browser drives the whole path: the coordinator asks
for an assessment and a disposition, the pharmacist sees the model's
recommendation in their queue and approves, the excursion leaves the open
list and both lots show as quarantined. Building the application exposed
three defects in the layers below it, each fixed with a test: a derived
datum listed a bound `$item` as a dependency, `HttpAdapter` could not
aggregate (it now aggregates over every page it reads, after the
runtime's row filter), and a map point's tone was overridden by its
default.

The stability figures are illustrative and documented as such in
`src/extensions/stability.ts`; the model is a deterministic stand-in in
`src/extensions/server.ts`, which a deployment replaces by pointing the
`qa-enclave` provider at its own model.
