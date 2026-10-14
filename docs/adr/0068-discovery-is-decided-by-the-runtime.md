# 0068. Discovery Is Decided by the Runtime, per Deployment

## Status

Accepted (2026-10-14). Implemented in `@typesys/core`
(`SemanticRuntime.describeModel(identity)`, the `discovery` option, the
`Discovery` type, `narrowModel`, `isAnonymous`, `HIGH_ASSURANCE_V2`;
`listActions` narrowed to match), `@typesys/http` (`/model`,
`/openapi.json`, `/discover` and `/query/validate` describe the model
through the runtime as the caller), `@typesys/mcp-server` (`typesys_list_types`,
`typesys_describe_type`, `typesys_discover`, `typesys_validate_query`, type
resources, `resources/list` and `tools/list` through the runtime;
`typesys_invoke_action`; enforcement keywords no longer sent) and the
Studio, which uses the HTTP API.

Proven by:

- `packages/domain-airforce/test/discovery.test.ts`: under need-to-know a
  maintainer cleared SECRET learns every airforce Type with its SECRET
  location and both Actions; a viewer is not told the location,
  `maintenanceStatus`, the value computed from it or any Action, not even
  by name anywhere in the description, while the released `needsAttention`
  stays with no input named; anonymous callers are refused and audited; an
  agent's model is decided too (the enclave model is not told the SECRET
  location, a commercial model is told nothing); `listActions` agrees; one
  audit row per call. Property-based (fast-check, fixed seed, 60 runs over
  generated roles, clearances and audiences): a Type is described exactly
  when a query of it is not refused, no returned object carries a member
  its description withholds, and nothing in a description names something
  it withholds. Modes: open (the default) describes everything to anyone;
  authenticated refuses anonymous callers only; an unknown mode is refused;
  `HIGH_ASSURANCE_V2` requires and supplies need-to-know.
- `packages/mcp-server/test/discovery-security.test.ts`: the maintainer and
  the viewer are each told one model by the runtime, `GET /api/model`, MCP's
  `typesys_list_types` and the types resource, the same discovery answers
  over MCP and REST, and an OpenAPI document with exactly their Actions; a
  withheld Type gets the same error as one that does not exist; anonymous
  callers are refused over REST and MCP, listed no Type resource and offered
  no Action tool; over MCP's HTTP transport `tools/list` follows the bearer;
  `typesys_invoke_action` is decided like an Action's own tool. In open mode
  `typesys_describe_type` carries no policy name, marking, data source or
  binding.
- `packages/studio/test/studio.test.ts`: the Studio shows each person the
  model the runtime describes to them, and anonymous access none.
- `packages/core/test/audit-completeness.test.ts` pins the two new
  unaudited call sites (`admitsSome`, `clearedToKnow`), which only
  discovery uses and `describeModel` audits per call.

## Context

ADR-0056 gave every consumer one model description, and the HTTP API, MCP
and Studio served it to any caller, anonymous included. Two problems:

- **It disclosed enforcement.** MCP's `typesys_describe_type` and the type
  resources sent each Type's raw schema, including `x-policy` (the names of
  the rules guarding it and its members), `x-provenance` (that
  `deploymentLocation` is marked SECRET), and the data sources and
  bindings behind relationships and computed values. ADR-0032 says markings
  are never disclosed to a caller; this path disclosed them to everyone.
- **Every caller learned everything.** Which Types, fields and Actions a
  system has is itself information: a viewer learned there is a SECRET
  deployment location, an Action they can never invoke, and a type
  hierarchy they cannot read. Some deployments are content with that (a
  public data catalog), and some are not (a classified enclave, where the
  existence of a compartment's fields is sensitive).

Each transport also decided this on its own (each called the registry
directly), which is the pattern ADR-0009 exists to prevent.

## Decision

**The runtime describes the model, as the caller.** `describeModel(identity)`
is a runtime operation like a read: rate limited, traced, audited (one row
per call, with the mode and what was described and withheld, by count),
and decided for the person and their audience (ADR-0067). The HTTP API,
MCP and the Studio call it and add nothing; transport code no longer
reads the registry to describe it.

**A deployment chooses how much discovery tells.** The runtime's
`discovery` option:

- `"open"` (default, the behavior before): the whole model to anyone.
- `"authenticated"`: the whole model, refused to an anonymous caller (the
  subject an identity resolver gives a caller with no valid credentials).
- `"need-to-know"`: refused to an anonymous caller, and otherwise
  narrowed to what the caller could use, decided by the same rules as
  their reads and invocations:
  - a Type when they are cleared for its markings and its read policy's
    plan for them is not `never` (a plan the engine cannot make is
    decided for the Type with no object, so an attribute rule hides it);
  - a property or relationship when they are cleared for its markings and
    its own policy, if any, passes the same test; a relationship also
    needs its target described;
  - a computed value when it passes the same test and each input is
    described or released (ADR-0052), with withheld inputs left out of its
    `dependsOn`;
  - an Action when its policy's plan admits them on some object of a
    described Type and they are cleared for its Types' markings;
  - `extends`, `required` and `aliases` only where they name something
    described.

  What the caller is sent never names what it withholds.

**What no caller is told, in any mode.** MCP's Type documents no longer
carry `x-policy`, `x-provenance`, `x-relationships`, `x-computed` or
`x-actions`; their public part was already in the document's own
`relationships`, `computedPropertyNames` and `actionNames`. A side effect
measured in `docs/evidence/devkit-2026-10-13.md`: `typesys_list_types` is
24% smaller for airforce, so the compact catalog's advantage over it is
smaller than ADR-0056 reported.

**Listing without a token.** MCP's `resources/list` and `tools/list`
carry no token. Under open discovery they list every Type and Action as
before; otherwise they list what the runtime describes to whoever the
transport resolves without one: the bearer of an HTTP request's header,
or, over stdio, an anonymous caller, who is listed none. A new
`typesys_invoke_action` tool reaches an Action by name with the token in
the call, so an agent over stdio can still use what `typesys_discover`
told it.

**A stricter profile.** `HIGH_ASSURANCE_V2` is V1's guarantees plus
need-to-know discovery, which it supplies when omitted and requires when
given. V1 is unchanged, because a profile version's guarantees never
change (ADR-0046).

## Consequences

- An enclave can run with the existence of its fields and Actions on a
  need-to-know basis, enforced by the same policies, plans and markings as
  its data, over every transport at once.
- Open discovery still tells anyone the whole model's shape, minus the
  enforcement keywords that should never have been sent; a deployment that
  minds says so with one option.
- `describeModel` under need-to-know costs a plan per Type, member and
  Action. The demo's models are small; a large model would want the
  description cached per role set, which is not built.
- Not addressed: the existence oracle in error messages (an Action the
  caller may not invoke is refused as "Not authorized", one that does not
  exist as "Unknown action"; likewise reads), Type and Action names in
  audit rows other callers may see, the `description` text a domain writes
  (the airforce one mentions SECRET in the property's own description,
  which need-to-know withholds with the property but open discovery
  sends), and per-object value markings from a source, which are decided
  per object and so do not narrow a description.
