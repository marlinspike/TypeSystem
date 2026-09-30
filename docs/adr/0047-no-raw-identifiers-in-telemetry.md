# 0047. No Raw Identifiers in Telemetry, and the Extension Trust Boundary

## Status

Accepted — implemented in `@typesys/core` (one telemetry redactor in
`runtime/runtime.ts`, `redactsTelemetryIdentifiers`, error redaction in
`observability/tracing.ts`, enumerated faults under a profile, the widened
`HIGH_ASSURANCE_V1` guarantees in `runtime/security-profile.ts`) and
`@typesys/mcp-server` (`telemetryResourceUri`, and its spans following the
runtime's policy). Proven by:

- `packages/core/test/observability.test.ts` — a world whose errors name
  the caller, objects, and a field value, run through every runtime
  operation, including a denied read, an adapter error naming a missing id,
  and a rate-limit refusal naming the subject. In the clear every
  identifier reaches the spans, so the attack is testing something. The
  **attack** under `"none"`, pseudonymous, and `HIGH_ASSURANCE_V1`: no
  subject id, object id, or value appears in any span attribute, status, or
  event, and each failure is still visible by its class name. Object
  pseudonyms are stable, differ per object and Type, and never equal a
  subject's. An error whose `name` is set to carry an id is recorded as
  plain `Error`.
- `packages/core/test/policy-faults.test.ts` — an **attack** where, under
  the profile, a custom engine's free-text faults become
  `external-policy-fault`, whether the decision allows or denies. That
  includes Cedar's `Cedar policy … errored` form, a string forged to start
  like the combinators' form, and one with an out-of-range number. The
  combinators' own faults and the runtime's are kept, and outside the
  profile ADR-0043's text is unchanged.
- `packages/mcp-server/test/telemetry.test.ts` — an **attack** where the
  bearer token in a resource URI never reaches a span, under any policy.
  Under `"none"` or pseudonymous, no object id, token, or subject reaches
  the MCP spans or the runtime spans beneath them, while the resource's
  category, Type, and relationship remain.

Mutation-checked (20 mutations): `"none"` or pseudonymous emitting the
object id; either keeping error messages; untagged subject or object
pseudonyms; a redacted exception or status keeping the message; accepting
any error `name`; not collapsing faults under the profile, or collapsing
them without it; an unanchored or unbounded fault pattern; the runtime
claiming it doesn't redact; the MCP URI keeping its query, its fragment, or
the object id, or accepting a non-resource URI; the MCP span recording
errors unredacted; and its unrecognized-URI error echoing the token. Each
one fails the suites.

## Context

ADR-0045 put the caller's subject id behind a policy — `none`, pseudonymous,
or `clear` — and ADR-0046's `HIGH_ASSURANCE_V1` defaults it to `none`. That
closed half the gap. Spans still carried `typesys.object_id`, and an object
id can identify a person as surely as a subject id: `PT-1001` is a patient.
Exception events and span status messages carried the error's message, and
the runtime's messages name objects (`Not authorized: read
hospital.Patient/PT-1001`) and subjects (`Rate limit exceeded for subject
…`). The MCP server's span recorded the whole resource URI, object id and
`?token=` included. Hiding one attribute while the same fact rides in
another is not a policy.

Separately, ADR-0043 audits the fault strings an engine returns, bounded
but otherwise as given. Under a high-assurance profile, an engine's free
text in the audit log is a channel for whatever the engine's error paths
happen to include.

And ADR-0046's profile checks what components *expose* about themselves. It
can't tell whether an in-process component is honest, and shouldn't
pretend to.

## Decision

**1. One telemetry policy covers every identifier.** `telemetryIdentity`
now governs how *any* identifier reaches a trace, through one redactor the
runtime resolves at construction:

| | `"clear"` (default) | pseudonymous | `"none"` (the profile's default) |
|---|---|---|---|
| caller | `typesys.identity.subject_id` | `typesys.identity.pseudonym` | — |
| object | `typesys.object_id` | `typesys.object_pseudonym` | — |
| exception events, status message | the error's message | the error's class name only | the error's class name only |

Pseudonyms are HMAC-SHA-256 under the deployment key over a tagged,
JSON-encoded input — `["subject", id]`, `["object", type, id]` — so a
subject's pseudonym can never equal an object's, and the same id in two
Types gives two pseudonyms. An error's class name is recorded only if it
looks like one; anything else is recorded as `Error`. Structural attributes
stay as they are: the operation, Type, relationship, property, and Action
names from the schema, plan kind, exactness, limitation codes, cache
outcome, query limit, and timing.

Code that opens its own spans around the runtime follows the same policy
through `runtime.redactsTelemetryIdentifiers`. The MCP server records a
resource URI without its query or fragment under every policy, since the
bearer token rides in `?token=`. When redacting, it records the category,
Type, and shape — `typesys://objects/airforce.Aircraft/{objectId}/relationships/components`.

**2. `HIGH_ASSURANCE_V1` guarantees no raw identifiers in telemetry.** Its
third guarantee is widened from caller identity to every subject, resource,
and object identifier, including inside error messages, and a seventh
states the fault rule below. V1 has not shipped in any release, so both
changes are made to V1 itself. Once a profile version is released, a
change like this is a new version.

**3. Under the profile, engine fault text collapses to fixed codes.** A
fault an engine returns is kept only if it is the combinators' own fixed
form, `anyOf alternative N failed to evaluate` with N at most four digits.
Any other string becomes `external-policy-fault`. Pattern-matching
arbitrary text can't make it safe: a custom engine can forge any string.
So this applies to Cedar's errored-policy faults too, whose policy ids stay
in its `onError` channel. The runtime's own fault for an engine that
throws is kept, since the runtime wrote it.

**4. The extension trust boundary, stated.** Custom policy engines,
adapters, classification schemes, caches, decorators, and key providers are
part of the trusted computing base. A security profile validates what they
expose (shape, `keyManagement`, `planAssurance`, `demonstration`) and
bounds what they return. It does not sandbox, attest, or second-guess code
running in the same process. A component that lies about itself defeats
the checks that rely on what it says.

## Consequences

- Under `HIGH_ASSURANCE_V1`, a trace names operations, Types, and outcomes,
  never who or what.
- Pseudonyms from ADR-0045 change: the subject input is now tagged.
- Under the profile, a Cedar policy error shows in the audit log as
  `external-policy-fault`, and by id in the operator's `onError` log.
- `@typesys/core` looks its tracer up per span, so an SDK registered, or
  replaced, after the module loads sees its spans.

**What a human must review before this is trusted in production.** This
code is machine-verified, not human-reviewed.

- **Type names are caller-supplied at the edge.** A query for a Type that
  doesn't exist still names what was asked for in the span and in the
  operation-duration metric's `type_name` label. The same goes for an
  unknown MCP tool name in `mcp.tool.name`.
- **Logs are not traces.** This covers spans that TypeS creates. An
  application's own logging, and the `onError` hooks, are the operator's.
- **Engine-authored deny reasons** reach the caller and the audit log as
  written. An engine's authors are responsible for keeping values out of
  them (ADR-0030), as part of the trusted computing base.

## Alternatives Considered

- **Special-case `typesys.object_id`.** Leaves the error messages, and the
  next identifier someone adds, uncovered; one redactor is the point.
- **Scrub identifiers out of error messages.** The runtime can't know every
  way a message embeds one; a class name is the only safe summary.
- **Allow-list fault strings by pattern.** A forged string matching a loose
  pattern passes. Only the combinators' anchored, digit-only form is safe
  to keep.
- **Sandbox extensions.** Out of scope for an in-process library; the
  boundary is stated instead of implied.
