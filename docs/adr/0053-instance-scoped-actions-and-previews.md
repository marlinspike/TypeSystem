# 0053. Instance-Scoped Actions, Action Previews, and Host/Origin Checks

## Status

Accepted — implemented in `@typesys/core` (`ActionDefinition.target`,
`ActionContext.target`, `SemanticRuntime.previewAction`, `listActions`'s
`objectId`, the shared `gateAction`), `@typesys/registry-store-postgres`
(migration `0003_action_target.sql`), `@typesys/mcp-server`
(`typesys_list_actions`, `typesys_preview_action`, `allowedHosts` and
`allowedOrigins` on the HTTP transport), `@typesys/adapter-mock-rest` and
`@typesys/domain-airforce` (`UpdateWorkOrderStatus`), with the matching
Cedar policy in `@typesys/policy-cedar`'s examples. Proven by:

- `packages/core/test/instance-scoped-actions.test.ts`: the Action's policy
  decided on the target's attributes (owner allowed, another team refused, a
  lead allowed); a target the caller may not read refusing the Action, with
  the read's deny audited and nothing executed; a missing target reported to
  a caller who may read the Type and refused to one who may not; an input
  naming no target decided per Type and audited; preconditions reading the
  target through `getProperty`; the success row naming the target; a cached
  target dropped after the write; `listActions` per object and per Type;
  registration refusing a malformed `target`. `previewAction`: a call that
  would run reported with nothing executed; each blocker in checking order,
  with nothing decided past the first failing gate; a throwing precondition
  reported unsatisfied; every decision audited under `previewAction` plus an
  outcome row.
- `packages/domain-airforce/test/update-work-order-status-action.test.ts`:
  the assignee, another maintainer, and a lead; a closed work order staying
  closed; `listActions` per work order.
- `packages/mcp-server/test/action-preview-tools.test.ts`: both tools over a
  real MCP client, outputs validated against their `outputSchema`.
- `packages/mcp-server/test/http-origin.test.ts`: localhost answered by
  default, a rebinding `Host` and a foreign `Origin` refused, a deployment's
  own names served, an explicit origin list, health endpoints untouched,
  and `"*"`. The official conformance suite's `dns-rebinding-protection`
  scenario now passes and is removed from its baseline.
- `packages/policy-cedar/test/parity.test.ts` still passes with the new rule
  in both engines.

Mutation-checked (5 mutations), each failing at least one test: the
Action's policy decided without the target's attributes; an unreadable
target treated as allowed; preconditions evaluated in a preview whose
earlier gate failed; the cached target not invalidated after a write; and
(by the conformance gate and `http-origin.test.ts`) the guard removed.

## Context

Three gaps the composition work depends on, each already listed:

- **Actions were decided per Type.** ADR-0030 made reads per instance, but
  an Action's `authorizationPolicy` saw only `{ typeName, actionName }`, so
  "an assignee may close their own work order" could not be written. The
  completeness inventory and ADR-0051's follow-ups both named it.
- **Nothing could ask what an Action would do.** `listActions` said whether
  the caller was authorized; nothing checked input or preconditions without
  executing. A workflow simulation, an agent planning a step, and a UI
  greying out a button all need that answer from the boundary, decided the
  same way the real call would be.
- **The HTTP transport validated neither `Host` nor `Origin`.** The
  conformance suite flagged it (ADR-0051 follow-up F): a web page could reach
  a server bound to localhost through DNS rebinding, and the demo's tokens
  are public.

## Decision

**Instance scope is declared on the Action**, as the input property that
carries the target's id:

```ts
target: { idFrom: "workOrderId" }   // type defaults to applicableTypes[0]
```

The id travels in the input so that every transport that can invoke an
Action (in-process, MCP, HTTP) names the target the same way, with no
transport-specific argument. Registration checks that the target Type is
one of `applicableTypes` and that `idFrom` is a required string property.

**One gate decides invoke, preview and listing** (`gateAction`). For an
instance-scoped Action it reads the target through the same
`authorizeRead` every read path uses (classification first, then the object
policy on stored attributes, then not-found only for an allowed caller,
ADR-0048), and then decides the Action's policy with
`{ objectId, attributes }` on the resource, so attribute rules and Cedar
policies decide per object exactly as they do for reads. A caller who may
not read the target cannot act on it. An input that names no target is
decided per Type, where an attribute rule denies, so the attempt is still
audited before input validation runs. Preconditions and the adapter receive
`ctx.target`, and `ctx.getProperty` reads the target's already-authorized
stored values. After a write to the target, its cache entries are dropped.

**`previewAction` runs the same gate, then input validation, then each
precondition, and stops there.** It never calls `executeAction`. It
returns an `ActionPreview`: whether the caller is authorized, whether the
input is valid, each precondition's result, the blockers in checking order,
`wouldExecute`, and the declared effects. Only a caller the policy allows
learns about input and preconditions; for anyone else those are `null`.
Every decision is audited under operation `previewAction`, plus one row
with `details.control === "preview"` and the blocker kinds. A precondition
may read through adapters, as it does on a real call; preconditions are
expected to be side-effect free, which this preview, like the real call,
relies on rather than enforces.

**MCP gains two read-only tools**, `typesys_list_actions` (with an
optional object id) and `typesys_preview_action`, so an agent can ask
before it acts.

**The HTTP transport checks `Host` and `Origin` on `/mcp`**, before
identity is resolved or a server is built: by default it answers only
`localhost`, `127.0.0.1` and `[::1]`, and a request carrying an `Origin`
must come from `http(s)://` on an allowed host. A deployment lists its own
names in `allowedHosts` (the demo entry point reads `MCP_ALLOWED_HOSTS`;
the reference Kubernetes config sets it), can pin `allowedOrigins`, or
passes `"*"` when a proxy enforces the check. `/healthz` and `/readyz` are
not gated, since orchestrators call them by pod IP.

## Consequences

- Existing Actions are unchanged: without `target`, an Action is decided
  per Type exactly as before.
- `listActions` now returns `{ action, authorized, instanceScoped }`; the
  added field is additive.
- An instance-scoped Action costs one read of its target before the write.
- A server reached by a name other than localhost refuses requests until
  that name is configured. That is a deliberate secure default and a
  breaking change for such deployments; the demo container and the k8s
  reference config are updated.
- A preview is not a reservation: state can change between a preview and
  the real call, which decides again from scratch.

## Alternatives Considered

- **A separate `objectId` argument on `invokeAction`.** It would need a new
  argument on every transport (MCP has no place for it except the input),
  and two places to name the same thing that could disagree.
- **Deciding Actions per instance only inside preconditions.** Preconditions
  are business rules, not authorization; they aren't audited as decisions,
  Cedar can't see them, and `listActions` couldn't report them.
- **A dry-run flag on the adapter (`executeAction(..., { dryRun })`).**
  Every adapter would have to implement it honestly. The preview stops
  before the adapter instead, which every adapter supports today; an
  adapter-level dry run can be added later as an optional hook.
- **The SDK's `enableDnsRebindingProtection` option on the transport.** It
  compares the whole `Host` value including the port, so a server on an
  ephemeral port (tests, `PORT=0`) can't list itself, and it checks after
  the per-request server is built. The guard here is port-agnostic and runs
  first.

## Amendments

**Amended 2026-10-14** (adversarial review, `packages/core/test/pressure-action-preview.test.ts`):
`ctx.getProperty` handed preconditions the target's raw stored values,
before classification and property policies, and `previewAction`'s
per-precondition `satisfied` (and `invokeAction`'s `PreconditionFailed`)
then disclosed one bit of a value the caller may not read, per call. It now
reads the target as the caller's own read shows it, decided as
`finalizeValues` decides it (classification, then the member's marking and
policy, whether or not the target has a value): a withheld value reads as
`undefined`. A precondition that reads one is not decided for that caller,
whatever it returns: the preview reports `satisfied: null` with a
`precondition` blocker, and `invokeAction` refuses with
`PreconditionFailedError` ("... (it reads a value the caller may not
read)"). Treating `undefined` as an answer would let a check such as
`status !== "closed"` pass for a caller who can't see `status`. The
adapter's `executeAction` context reads the same caller-visible values.
