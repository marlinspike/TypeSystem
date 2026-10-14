# 0072. Independent Services Behind One Governed Contract

## Status

Accepted (2026-10-14). Implemented in:

- `@typesys/adapter-http` (`packages/adapter-http/`): a declarative
  HTTP/JSON Adapter.
- `SourceRefusedError`, and `optional` relationships with
  `ResolvedObject.unavailable`, in `@typesys/core`.
- `packages/sortie-readiness/`: the model, the three adapters' mappings,
  and the host.

The three services are in `examples/services/`. They are plain Node with
no TypeSystem code. Proven by `packages/sortie-readiness/test/interop.test.ts`
(every scenario below) and `packages/adapter-http/test/http-adapter.test.ts`.
The mission application over them is
`examples/missions/sortie-readiness`, verified by `typesys engineer
verify` (ADR-0071) in `packages/sortie-readiness/test/mission.test.ts`.

## Context

Until now, every TypeSystem source was written alongside TypeSystem: an
in-memory repository, a mocked REST system seeded by the same process,
and Postgres tables TypeSystem created. Those sources show the adapter
seam (ADR-0006) and cross-source composition (ADR-0022, ADR-0023). They do
not show what happens when the systems underneath were built by other
people, for other purposes. Such systems have:

- their own field names and codes,
- their own paging,
- their own authorization, which TypeSystem cannot see into,
- their own release schedule,
- their own outages.

A semantic layer that only works over sources it controls has not been
tested where it matters.

Three questions follow, and the existing runtime answered each badly or
not at all:

- **What does a read return when one of several services is down?**
  Before this ADR, any adapter error failed the whole read. An aircraft
  whose crew roster was unreachable could not be read at all, although
  its own record was fine.
- **Who refused?** A service refusing TypeSystem's credential surfaced as
  a generic error, or, from a list endpoint, as an empty list
  indistinguishable from "no crew assigned".
- **What changes when a service changes its schema?** It should be one
  mapping, but the existing adapters held their mappings in code.

## Decision

**Three independent services.** `fleet-registry`, `parts-depot` and
`crew-roster` are each a separate process with a separate data model and
separate authorization:

| Service | Data model | Authorization | Paging |
|---|---|---|---|
| `fleet-registry` | `tail_no`, `mds`, `mc_status` codes | API keys with scopes | cursor |
| `parts-depot` | requisitions by document number; schema v1 is flat, v2 nested and renamed | a depot key per base: a key sees only its bases' rows | none |
| `crew-roster` | members, quals, duty status | OAuth 2.0 client credentials with scopes; `full_name` only with `roster.pii` | none |

None imports TypeSystem, and none knows the others exist.

**A declarative HTTP adapter.** `HttpAdapter` takes, for each Type:

- a path for one record and a path for a list;
- where the list's items and next cursor are;
- which canonical fields the service can filter on;
- for each canonical field, a JSON Pointer (RFC 6901), optionally with a
  table translating the service's codes (`FMC` → `full`).

Authorization is a header credential, or OAuth 2.0 client credentials
(RFC 6749 §4.4), cached and renewed once on a 401.

Every condition of a query is still decided by `matchesFilter` itself.
The service filters what it can, so `canFilter` is truthful (ADR-0040). A
list larger than `maxPages` is refused, never answered from a truncated
read.

Provenance names the service's own field (`mc_status`, `quantity`,
`state`), so a value can be traced to the record and field it came from.

**Errors keep their meaning across the boundary.**

| What happened | What the adapter reports |
|---|---|
| The service refused the credential (401, 403) | `SourceRefusedError`, not retryable |
| The service did not answer usefully (5xx, a connection error, non-JSON) | `AdapterUnavailableError` |
| The service does not hold the record (404) | an empty result |
| The runtime's deadline (ADR-0026) expired | `AdapterTimeoutError` |

A refusal is never folded into "nothing found".

**Optional relationships, and partial answers that say so.** A
relationship may be declared `optional: true`. When an include of an
optional relationship fails because its source is unavailable, timed out
or refused TypeSystem's credential, the runtime does three things:

- It omits that include from the object's values. It does not return
  `[]`, which would claim there is no crew.
- It records `{ path, dataSourceId, reason, message }` in the object's
  `unavailable` list, where `reason` is `"unavailable"`, `"timeout"` or
  `"refused-by-source"`.
- It returns everything else.

A required relationship, a direct `getRelationship`, and the object's own
properties still fail as before. `unavailable` is part of the object, so
the HTTP API, MCP and the SDK return it unchanged.

The partial answer is limited to related objects deliberately. Property
values feed the source object's own authorization (ADR-0030), so a
missing value could change a policy decision. A related set never does.

**Both layers authorize.** TypeSystem holds one credential per service,
and that credential's grant is the service's decision. A read passes only
when TypeSystem's policy allows the caller *and* the service allows
TypeSystem's credential:

- The depot's hill key cannot read a KVPS requisition that TypeSystem's
  policy would let a planner read. The read is refused, with
  `SourceRefusedError` naming the depot.
- The roster sends no names to a client without `roster.pii`, whatever
  TypeSystem's policy says.
- With `roster.pii`, TypeSystem still withholds names from anyone who is
  not a planner of that crew member's unit.

## Consequences

- One query returns an aircraft from the fleet registry, its crew from
  the roster and its requisitions from the depot. The includes are read
  concurrently, so two services each 400 ms slow cost one wait. A service
  slower than the deadline is reported as `timeout`, and the rest arrives
  on time.
- When the roster is down, the aircraft still comes back with its
  requisitions, and `unavailable` names the crew roster. A depot that
  rejects TypeSystem's key is reported as `refused-by-source`, not as no
  requisitions.
- A service that refuses a request outright stays a refusal end to end.
  Asked for another base's requisitions, the depot answers 403, and the
  query fails with `source-refused` (HTTP 502) naming the depot. Only a
  list the service narrows itself, such as the hill key's list holding
  KHIF's rows alone, comes back as a shorter list.
- The sortie-readiness mission's 15 checks pass through the engineering
  loop, each against a freshly started application that starts its own
  three services. A sign-off opened to maintainers in the application
  fails exactly the check that excludes them.
- The depot's upgrade from schema v1 to v2 changes `DEPOT_SCHEMAS` and
  nothing else. Three consumer responses through the HTTP API are
  byte-for-byte identical before and after. Provenance changes, as it
  should, to name the new field.
- Not addressed:
  - Per-user delegation to a service (OAuth token exchange, RFC 8693).
    TypeSystem calls each service as itself, so a service cannot tell
    which person a read is for. Its authorization bounds what TypeSystem
    may read, not what each person may read.
  - Writes (Actions) through `HttpAdapter`.
  - Partial answers for property values split across sources (ADR-0023).
    Those still fail the read.
  - A service's list larger than `maxPages` pages is refused rather than
    streamed.
