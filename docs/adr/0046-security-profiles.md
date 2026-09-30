# 0046. Security Profiles: `HIGH_ASSURANCE_V1`

## Status

Accepted — implemented in `@typesys/core` (`runtime/security-profile.ts`:
`HIGH_ASSURANCE_V1`, `SecurityProfileError`, `KeyManagement`,
`PlanAssurance`; the construction-time check and the aggregation assurance in
`runtime/runtime.ts`; `planAssurance` in the ABAC engine; `demonstration` on
the demo schemes; `keyManagement` on `Adapter` and `Cache`) and
`@typesys/encryption` (`KeyProvider.management`, `keyManagement` on
`EncryptingAdapter` and `EncryptedCache`). Proven by:

- `packages/core/test/security-profile.test.ts` — the profile frozen and
  versioned; exact row security supplied and the profile reported; an
  **attack** block where explicit downgrades are refused together, an
  unknown option name (`rowSecurty`) is refused, unknown, future, forged,
  `null`, and string profiles are refused, demonstration schemes
  (`DEMO_LINEAR_CLASSIFICATION`, `securityLabels`) are refused while a
  deployment's own scheme starts, local and unknown key management on an
  adapter or cache are refused while managed starts, and a malformed scheme,
  engine, `planAssurance`, cache, or pseudonym key is refused; the ABAC
  combinators' assurance for leaf, nested, opaque-child, hand-planned, and
  over-hand-planned rules; and an **attack** where an exact but hand-written
  plan serves reads but can't admit an aggregate — audited as a refusal —
  while the same plan admits it without the profile, a structural plan
  admits it, and an engine that can't vouch, fails to, or answers anything
  but `"structural"` can't.
- `packages/encryption/test/security-profile.test.ts` — each component
  reporting its key management; local keys on an adapter or a cache, or a
  provider that won't say, refused; KMS-managed keys accepted.
- `packages/policy-cedar/test/planning.test.ts` — without the operator's
  `schemaConformantData` assertion a Cedar query on an attribute-bearing
  Type is refused and with it runs, and an exact Cedar plan still can't
  admit an aggregate while the ABAC engine's structural plan does.

Mutation-checked (16 mutations, all type-valid): dropping the row-security,
telemetry, unknown-option, key-management (to "local" only), or
demonstration check, or the aggregation assurance; accepting any truthy
assurance; supplying `"post-filter"`; accepting any profile; letting one
structural child make a combinator structural; and an `EncryptingAdapter`
defaulting an unknown provider to managed — each fails the suites.

`AwsKmsKey` gains a production gate, `test/aws-kms.production-gate.test.ts`,
run against real AWS KMS when `TYPESYS_AWS_KMS_KEY_ID` and
`TYPESYS_AWS_KMS_OTHER_KEY_ID` are set; it has not been run here.

## Context

Most of TypeS's security options default to the behavior the runtime had
before the option existed: post-filtered row security, subject ids in
traces, whatever key provider the adapter was given. That keeps upgrades
safe, but it means a deployment that needs the strongest guarantees has to
know every option, set each correctly, and notice when one is misspelled —
`rowSecurty: "require-exact"` is silently ignored. A boolean `strict: true`
would bundle the settings but not say what it *guarantees*, and would drift
as options are added: `strict` next year wouldn't mean what it meant when an
assessor signed off.

What an operator and an assessor need is a named, versioned statement of
guarantees the runtime checks and refuses to start without.

## Decision

**1. A profile is a versioned set of guarantees.** `securityProfile:
HIGH_ASSURANCE_V1` (id `typesys:high-assurance:1`). Its guarantees are fixed
for that version; a stricter set is a new version, never a change to this
one. The runtime accepts only profiles it implements, by id, and exposes the
one in force (`runtime.securityProfile`, and in `explainQuery`'s report).

**2. `HIGH_ASSURANCE_V1` guarantees**, each checked at construction unless
it can only be checked per request:

1. **Row security is exact.** `rowSecurity` is `"require-exact"`; a query
   whose plan isn't exact is refused (ADR-0038).
2. **Aggregation is admitted only by a structurally derived plan.** An
   aggregate over row-scoped data runs under an exact plan only if the
   engine derived that plan from the same rule structure it evaluates
   (`planAssurance` is `"structural"`) — the ABAC combinators. Ordinary
   reads keep their per-object check after retrieval; an aggregate has no
   such backstop, so a plan from Cedar's experimental partial evaluation
   (ADR-0039), or from a hand-written `plan`, is refused for aggregation,
   and used only for reads.
3. **Telemetry doesn't carry identity in the clear.** `telemetryIdentity`
   is `"none"` or pseudonymous (ADR-0045).
4. **Keys are managed.** No adapter or cache the runtime is given may report
   local or unknown key management: `LocalKeyProvider` is refused, and a
   `WrappedKeyProvider` over a KMS is required for encryption (ADR-0037).
5. **No demonstration components.** A classification scheme marked as a
   demonstration — `DEMO_LINEAR_CLASSIFICATION`, the reference
   `securityLabels` (ADR-0041) — is refused. Real marking schemes are
   governed implementations of `ClassificationScheme`, kept out of core.
6. **Security configuration is well-formed.** Unknown option names are
   refused; the policy engine, the classification scheme, and the cache
   must have the shape their interfaces require.

**3. Downgrades are refused, not overridden.** Where a guarantee fixes a
setting, the profile supplies it if it is omitted, and a runtime given a
weaker one — `rowSecurity: "post-filter"`, `telemetryIdentity: "clear"` —
refuses to start. Every violation is reported at once, in a
`SecurityProfileError` listing them.

**4. The profile asserts nothing about the world.** Whether a store enforces
the schema's types (`schemaConformantData`, ADR-0039) is a fact about the
deployment, not a preference; the profile never sets it. Under guarantee 1,
a Cedar-guarded query on a Type with declared attributes is refused unless
the operator has made that assertion.

## Consequences

- A deployment states one versioned profile and gets a startup failure, not
  a quiet weakening, for anything that falls short of it.
- Under the profile, Cedar-guarded aggregation over row-scoped Types is
  refused until Cedar planning is verified more strongly than partial
  evaluation allows today.
- Custom `KeyProvider`s declare `management`, and components that encrypt
  expose `keyManagement`, so the profile can check them.

**What a human must review before this is trusted in production.** This
code is machine-verified, not human-reviewed.

- **A profile checks what it can see.** A decorator wrapped around an
  `EncryptingAdapter` that doesn't forward `keyManagement` hides it; a
  custom `PolicyEngine` that claims `"structural"` planning is believed.
- **The profile is necessary, not sufficient.** It says nothing about TLS,
  the identity provider, the audit store's access controls, or anything in
  `PRODUCTION-READINESS.md` beyond these guarantees.

## Alternatives Considered

- **`strict: true`.** Names no guarantees and changes meaning as options
  are added.
- **Let explicit options override the profile.** Then the profile guarantees
  nothing: one line in a config file undoes it.
- **Verify Cedar plans for aggregation by deciding every admitted row.**
  Restores the backstop, at the cost of reading every row the aggregate
  spans; a candidate for a later version, not this one.
- **Make the profile assert `schemaConformantData`.** A profile can't know
  what a store enforces.
