# How to run under the high-assurance profile

`HIGH_ASSURANCE_V1` is a versioned set of guarantees the runtime checks at
start-up and refuses to run without
([ADR-0046](../adr/0046-security-profiles.md)):

```ts
import { HIGH_ASSURANCE_V1, SemanticRuntime } from "@typesys/core";

const runtime = new SemanticRuntime(registry, adapters, policyEngine, {
  securityProfile: HIGH_ASSURANCE_V1,
  classification: myGovernedScheme,                       // not a demonstration scheme
  telemetryIdentity: { mode: "pseudonymous", key },       // or omit for "none"
  cache: new EncryptedCache(new RedisCache(redis), keys)  // keys from WrappedKeyProvider
});
```

What it guarantees, and what it therefore requires of you:

| guarantee | what you provide |
|---|---|
| Row security is exact: an inexact plan's query is refused | rules the planner can plan exactly — the ABAC helpers, or Cedar with `schemaConformantData` asserted *by you* for attribute-bearing Types |
| Aggregation only through structurally derived plans | ABAC helper rules for any row-scoped Type you aggregate; Cedar-guarded aggregates are refused |
| No raw identifiers in telemetry: no subject or object id in any span, errors by class name only | `telemetryIdentity` `"none"` (the default here) or pseudonymous with a 32-byte key |
| Managed keys | `WrappedKeyProvider` over a KMS — `LocalKeyProvider` is refused |
| No demonstration components | your own governed `ClassificationScheme`, not `DEMO_LINEAR_CLASSIFICATION` or `securityLabels` |
| Well-formed configuration | no misspelled options; complete engines, schemes, and caches |
| Enumerated engine faults: anything but the combinators' fixed form is audited as `external-policy-fault` | nothing; for a Cedar policy error, its id is in your `onError` log |

A weaker explicit setting — `rowSecurity: "post-filter"`,
`telemetryIdentity: "clear"` — isn't overridden; the runtime refuses to start
and a `SecurityProfileError` lists every violation. `runtime.securityProfile`
and `explainQuery` report the profile in force.

**The trust boundary.** Custom policy engines, adapters, classification
schemes, caches, decorators, and key providers are part of your trusted
computing base ([ADR-0047](../adr/0047-no-raw-identifiers-in-telemetry.md)).
The profile validates what they expose, such as their shape,
`keyManagement`, `planAssurance`, and `demonstration`, and bounds what they
return. It doesn't sandbox or attest them: a component that misreports
itself defeats the checks that rely on it.

The profile is necessary, not sufficient: TLS, the identity provider, the
audit store's access controls, a real-AWS run of `AwsKmsKey`'s production
gate, and the rest of [`PRODUCTION-READINESS.md`](../PRODUCTION-READINESS.md)
are still yours.
