# 0045. Telemetry Identity Policy

## Status

Accepted — implemented in `@typesys/core` (`TelemetryIdentity` and the
`telemetryIdentity` option in `runtime/runtime.ts`, resolved once, applied to
every operation span). Proven by `packages/core/test/observability.test.ts`
against a registered OpenTelemetry SDK: `"none"` leaving no identity on any
span; pseudonyms 128-bit, stable per subject and key, different per subject
and per key, neither the id nor its unkeyed hash, and the id nowhere in the
spans; the audit log keeping the subject id under `"none"`; and an
**attack** block of malformed policies — unknown or miscased modes, a
missing, short, or string key, `null` — each refused at construction; the
default still `"clear"`.

Mutation-checked (5 mutations): `"none"` emitting the id, dropping the key
length check, hashing without the key, treating `null` as the default, and
accepting an unknown mode — each fails the suite.

## Context

Every runtime span carries `typesys.identity.subject_id` (ADR-0017): the
caller's subject id, in the clear. The audit log must name its subjects — it
is the attributable record, append-only and access-controlled — but traces
travel much further: to a collector, a vendor, dashboards, long-retention
storage, people debugging latency who have no business knowing who read
what. A subject id is often an email address or an employee number. The
exposure surface of telemetry is the wrong place to spend attributability
by default in a high-assurance deployment, and a deployment should have to
say what it wants.

## Decision

**1. `telemetryIdentity`: `"none"`, `"clear"`, or `{ mode: "pseudonymous",
key }`.** A runtime option, resolved once at construction:

- `"clear"` — today's behavior: `typesys.identity.subject_id` is the subject
  id. The default, so nothing changes for a deployment that doesn't ask.
- `"none"` — no identity attribute on any span.
- pseudonymous — `typesys.identity.pseudonym`: an HMAC-SHA-256 of the
  subject id under a deployment key of at least 32 bytes, 128 bits in
  base64url. Stable for a subject under one key, so traces still group by
  caller; not reversible or guessable without the key, where a plain hash
  of an email address is. A different attribute name, so no one mistakes a
  pseudonym for an id.

**2. Malformed configuration fails at construction.** An unknown mode, or a
key that isn't at least 32 bytes, throws.

**3. Only telemetry changes.** Audit rows keep the subject id: they are the
attributable record. Metrics never carried identity.

## Consequences

- A deployment can keep caller identity out of its traces, or keep only a
  keyed pseudonym, without losing the audit trail.
- The high-assurance profile (ADR-0046) defaults to `"none"` and refuses
  `"clear"`.

**What a human must review before this is trusted in production.** This
code is machine-verified, not human-reviewed.

- **The pseudonym key is a secret.** Anyone holding it can test a guessed
  subject id against a pseudonym. Keep it out of the telemetry pipeline's
  configuration, and rotate it knowing that pseudonyms change with it.
- **Other span attributes can identify too.** `typesys.object_id` names the
  object read — sometimes a person's record. This ADR is about the caller.

## Alternatives Considered

- **An unkeyed hash.** Subject ids are guessable, so a hash is a lookup
  table away from the id.
- **Change the default to pseudonymous.** Needs a key the runtime can't
  invent, and would silently change every existing deployment's traces; the
  profile makes the stricter choice explicit instead.
- **Drop identity from spans altogether.** Some deployments rely on it to
  investigate one caller's latency; the policy lets them choose.
