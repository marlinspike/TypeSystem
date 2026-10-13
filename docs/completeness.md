# How Complete Is This?

An honest inventory, kept up to date as the codebase changes — the
architecture and its contracts are complete; the implementation is a
proven, extending vertical slice, not a finished platform.

This page answers "what's built and tested versus a documented extension
point" for the architecture *as it exists*. Whether it is safe to run
against real production traffic is a different question. For that, see
[`PRODUCTION-READINESS.md`](PRODUCTION-READINESS.md), the ranked list of
what closing that gap would actually take (a real policy engine, a
threat model, production-scale load numbers, and more), and
[ADR-0024](adr/0024-production-readiness-gap.md) for the decision to
document that gap rather than close it in this pass.

## Fully built, tested, and demonstrated

- Meta-model + registry: Type/Relationship/Action/Policy/DataSource/Mapping,
  `extends` + trait composition, semver versioning with a real alias/
  deprecation transition test.
- Runtime: object retrieval, relationship navigation (concurrent, not
  N+1 — see [ADR](adr/) history), structured query, provenance (including
  aggregation for computed properties), Action invocation — all policy-
  and audit-gated in one place.
- Three adapter styles proven substitutable behind an identical interface:
  in-memory repo, mocked external REST, and a real PostgreSQL-backed
  adapter (`@typesys/adapter-postgres`) — object retrieval, filtered
  queries, and both relationship conventions proven against actual rows,
  not mocks. All three combine pairwise, not just individually: a real
  PostgreSQL-backed `Widget` with a relationship *and* a per-property
  Mapping override both resolving through a different, real
  `InMemoryRepositoryAdapter` (`packages/adapter-postgres/test/cross-adapter-composition.test.ts`).
- Two independent domains, both real code: `domain-airforce` and
  `domain-hospital` (Patient/Provider/Appointment), the latter proving
  domain-neutrality (ADR-0013) end-to-end — real relationship resolution
  (`byForeignKey`/`byOwnField`), `extends core.Person` composition,
  object/property policy boundaries, and a real MCP connection browsing
  it with zero changes to `resources.ts`/`tools.ts`.
- All three ways to combine data from multiple sources into one object
  graph/object are real and tested, not just modeled: relationships
  crossing adapters (ADR-0006), a computed property deriving its value
  from a second adapter it has no direct Mapping to
  (`Aircraft.needsAttention`, ADR-0022), and per-property Mapping
  overrides merging a Type's own fields from several DataSources into
  one `getObject`/`query` read (ADR-0023). See
  [`docs/how-to/combine-multiple-sources.md`](how-to/combine-multiple-sources.md).
- A production PostgreSQL `RegistryStore` — real migrations, an
  append-only audit table enforced by a DB trigger, keyset-paginated
  audit queries, a `BindingRegistry` seam for the behavior a database can
  never store (ADR-0015). Every audit row names the runtime operation it
  was written under — the outermost call (ADR-0042,
  `packages/core/test/audit-operation.test.ts`) — and any rule branch that
  failed to evaluate, even under an allow (ADR-0043,
  `packages/core/test/policy-faults.test.ts`).
- Telemetry identity policy (ADR-0045): spans carry the caller in the clear
  (the default), not at all, or as a keyed HMAC pseudonym
  (`packages/core/test/observability.test.ts`). Since ADR-0047 the same
  policy covers object ids and span error messages, in the runtime's spans
  and the MCP server's. The MCP spans never record the bearer token
  (`packages/mcp-server/test/telemetry.test.ts`).
- A versioned security profile, `HIGH_ASSURANCE_V1` (ADR-0046): exact row
  security, aggregation only through structurally derived plans, no raw
  identifiers in telemetry, managed keys, no demonstration components,
  well-formed configuration, and enumerated engine faults (ADR-0047),
  checked at construction with every violation
  reported and every downgrade refused
  (`packages/core/test/security-profile.test.ts`,
  `packages/encryption/test/security-profile.test.ts`).
- A TTL-based cache for `resolutionMode: "cached"` properties,
  relationships, and computed properties, opt-in per mapping, with a
  manual `invalidateObject` escape hatch (ADR-0016).
- Bounded-concurrency fan-out for every relationship/query/provenance
  resolution (a large relationship or query page can no longer open
  unlimited simultaneous adapter calls), plus an opt-in per-identity
  token-bucket `RateLimiter` checked once at every public runtime entry
  point (ADR-0019).
- Input validation at the runtime boundary: `query` is checked against
  `semanticQuerySchema` and `QueryLimits` (default page 100, max 1000,
  bounded include count/depth and filter depth/size), and `invokeAction` input
  against each Action's `inputSchema`, all throwing `InvalidInputError`
  (`packages/core/src/runtime/input-validation.ts`). The MCP `typesys_query` tool
  advertises the same schema.
- Multi-instance deployment (ADR-0025): `@typesys/redis`'s `RedisCache`
  and `RedisRateLimiter` share cache entries, invalidation, and
  per-identity budgets across replicas; migrations serialize on a
  Postgres advisory lock. Proven by tests with two runtimes on one Redis
  and several registries on one Postgres, and by `npm run load-test`,
  which CI runs with two processes sharing Redis.
- One concurrency budget per request: `maxConcurrency` caps the adapter
  calls of a whole top-level call, nested fan-out and computed properties
  included, rather than each fan-out level separately (ADR-0025).
- Deployment artifacts (ADR-0029): `/healthz` and `/readyz` on the HTTP
  transport (covered by `packages/mcp-server/test/http-health.test.ts`), a
  multi-stage `Dockerfile`, a `docker-compose.yml` (Postgres + Redis + one-shot
  migration + N app replicas + nginx), and reference Kubernetes manifests
  (`deploy/k8s/`) with probes and a migration `Job`. The container/compose/k8s
  files are inspected reference artifacts — correct and runnable, but not built
  or run in CI, and not production-hardened (image scanning, secrets, TLS
  remain `PRODUCTION-READINESS.md` items).
- Field-level encryption at rest (ADR-0033): `@typesys/encryption`'s
  `EncryptingAdapter` wraps any adapter so configured fields are AES-256-GCM
  ciphertext in the store (randomized by default; deterministic fields add
  an HMAC blind index so `eq`/`ne`/`in` still work), behind a `KeyProvider`
  seam whose keyring handles rotation. Operations that would need plaintext
  in the store (range, substring, search, sort, aggregation, key-based
  relationships) are refused with `EncryptedFieldError`; tampered, moved,
  wrong-key, or legacy-plaintext values fail the read with
  `DecryptionError`. Every ciphertext is bound to its record (ADR-0035,
  `tsenc2`), so one moved between records fails closed; unbound legacy
  envelopes are refused outside a migration, and `reseal` migrates and
  re-keys. Proven by `packages/encryption/test/`, including reading the store
  directly, tampering, moving and downgrading ciphertexts, and a transparency
  check across every hospital read path; the Postgres suite runs in CI.
  Encrypted and marked data never reaches a cache that isn't confidential
  (ADR-0036): the runtime reads it live instead, and `EncryptedCache` seals
  a shared cache's values and hides its key names. Proven by
  `packages/core/test/sensitive-caching.test.ts` and
  `packages/encryption/test/encrypted-cache.test.ts`. Keys can come from a
  KMS (ADR-0037): `WrappedKeyProvider` unwraps data keys at startup or
  refuses to start, and leases them so a revoked KMS key stops every use
  within `maxKeyAgeMs`; `@typesys/kms-aws` is the AWS KMS key, tested
  against a fake and, in CI, the `local-kms` emulator — not AWS itself.
- Data classification enforcement (ADR-0032): `Identity.clearance` must
  dominate a Type's `x-provenance.defaultClassification`, a member's
  `x-provenance.properties[].classification`, and a value's
  `ProvenanceRef.classification`, under a pluggable `ClassificationScheme`
  (default `DENY_MARKED_DATA` — marked data denied until a scheme is
  configured, ADR-0034 — with `DEMO_LINEAR_CLASSIFICATION`'s `UNCLASSIFIED <
  CUI < SECRET < TOP_SECRET` for demos; fail-closed on missing or unknown
  labels). Enforced once, at `SemanticRuntime`, beside the policy
  engine: classified objects are refused before any adapter call, values
  redacted with their provenance, computed properties inherit their inputs'
  markings, probes by filter/sort/search/aggregate refused, Actions on
  classified Types refused — all audited. The airforce demo's SECRET
  `deploymentLocation` shows it; `packages/core/test/data-classification.test.ts`
  proves it with an attack suite. Schemes decide whole labels and join
  derived ones (ADR-0041): the runtime decides the join and every marking on
  its own, and the reference `securityLabels` scheme models levels,
  compartments, releasability, CUI as its own regime, and accreditation
  (`packages/core/test/security-labels.test.ts`). Not addressed: value-level markings inside
  adapter-side aggregation, per-record object markings, and write
  (`*`-property) rules — see the ADR.
- A real, analyzable policy engine (ADR-0031): `@typesys/policy-cedar`'s
  `CedarPolicyEngine` runs the Cedar authorizer in-process as WebAssembly
  behind the unchanged `PolicyEngine` interface. Policies are strictly
  validated against a Cedar schema at load (errors *and* warnings refuse to
  build the engine), only schema-declared attributes reach a policy, and a
  decision allows only on a Cedar `allow` with no evaluation errors. A
  reference policy set reproduces both demo domains' rules, including the
  own-patient rule; `packages/policy-cedar/test/parity.test.ts` proves it
  decides identically to `AbacPolicyEngine` — same results and the same
  audited decision at every checkpoint across 2,422 scenarios — and pins the
  intended fail-closed divergences (a malformed declared attribute).
- Row-level (instance) authorization (ADR-0030): policies receive the
  object's stored attributes and decide per instance on every read path —
  `getObject`, each returned `query` item (denied items dropped silently,
  audited), a relationship's source and targets, and provenance — with
  property/relationship policies that narrow the object policy, aggregation
  that fails closed under an instance rule, and a deny-biased enforcement
  point (a throwing or malformed policy denies). Composable helpers
  (`requireAttributeMatch`, `anyOf`, `allOf`) ship; the hospital domain's
  own-patient rule uses them. Proven by
  `packages/core/test/row-level-authorization.test.ts` and
  `packages/domain-hospital/test/row-level-authorization.test.ts`, including
  attack suites. Instance-scoped Actions followed in ADR-0053.
- Derived values inherit their inputs' read policy (ADR-0052): a computed
  property is withheld from a caller who may not read every input it
  depends on, transitively and even where the input has no value, unless the
  Type lists the input in `releases`; each withholding and each release is
  audited, and markings are never released. Proven by
  `packages/core/test/derived-value-release.test.ts`, mutation-checked. Not
  addressed: what a derivation reads through `ctx.getAdapter` about other
  objects is the domain author's responsibility, not checked by the runtime.
- Instance-scoped Actions and Action previews (ADR-0053): an Action may
  name the object it acts on (`target: { idFrom }`), which the runtime reads
  under the caller's read authorization before deciding the Action's policy
  on that object's attributes, with Cedar parity; `previewAction` decides an
  invocation (authorization, input, each precondition) and executes nothing;
  `listActions` decides per object when given one. MCP exposes both as
  `typesys_list_actions` and `typesys_preview_action`, and the HTTP transport
  validates `Host` and `Origin` against DNS rebinding (the conformance
  suite's scenario now passes). Proven by
  `packages/core/test/instance-scoped-actions.test.ts`,
  `packages/domain-airforce/test/update-work-order-status-action.test.ts`,
  `packages/mcp-server/test/action-preview-tools.test.ts` and
  `packages/mcp-server/test/http-origin.test.ts`, mutation-checked. Not
  addressed: a preview relies on preconditions having no side effects; an
  adapter-level dry run of the write itself.
- Filtering on computed properties and explainable execution plans
  (ADR-0054): a filter's conjuncts that name computed properties run in the
  runtime on each object's finalized, caller-visible values (so a withheld
  value can't be probed), the rest in the adapter; pages are refilled until
  full, the source runs out, or `maxScanned` rows were read, with a cursor
  that resumes exactly where the call stopped. `explainQuery` reports the
  execution plan derived from the same split, and MCP's
  `typesys_explain_query` returns it without the authorization plan. Proven
  by `packages/core/test/computed-filter-pagination.test.ts`, which checks
  60 generated queries against a brute-force reference, and mutation-checked.
  Not addressed: sorting by a computed property; batching computed
  properties across a page.
- A typed SDK generated from the registry (ADR-0055): `@typesys/sdk`'s
  `generateModel` emits each Type's flattened properties, computed
  properties typed by a declared value `schema` (which the registry compiles
  and the runtime enforces on every computation), relationships and
  Actions; `createClient<Model>()` builds immutable queries that compile to
  the query DSL and nothing else, over the runtime in process or a TypeS
  MCP server. `typesys generate-sdk --check` and `npm run sdk:models --
  --check` catch a stale model. Proven by `packages/sdk/test/` (twelve
  compile-time refusals checked by `npm run typecheck`; six queries for
  three callers returning exactly what `runtime.query` returns, on both
  transports) and `packages/cli/test/generate-sdk.test.ts`, and
  mutation-checked. Not addressed: aggregates through the builder;
  structured error codes over MCP.
- One model description, discovery, validation and contract diff
  (ADR-0056): `describeModel` in core composes every Type as the registry
  does and is the one input to the SDK generator and `@typesys/devkit`.
  Agents get `typesys_discover` (a few ranked, compact entries for a task,
  about a tenth the size of `typesys_list_types` on the demo) and
  `typesys_validate_query` (every unknown name with the one probably meant,
  every condition that can never match); the CLI gets `describe`, `diff`,
  `discover` and `check-query`, with `diff` failing on a breaking or
  under-versioned change. Proven by `packages/devkit/test/devkit.test.ts`,
  whose soundness check runs 1,620 generated filters through the runtime,
  plus MCP and CLI tests, and mutation-checked. Not addressed: discovery is
  lexical; the diff cannot see behavior changes behind an unchanged schema.
- One request context per process, not per runtime: every
  `SemanticRuntime` used to create its own `AsyncLocalStorage`, which on
  Node 22 taxes every promise in the process for as long as it runs, so
  each runtime constructed slowed every later `await` (a query loop ran
  seventeen times slower after a test suite's worth of runtimes). Request
  contexts now name their runtime, so a call into another runtime from
  inside a request still gets its own budget and audited operation. Proven
  by `packages/core/test/request-concurrency-budget.test.ts`, and
  mutation-checked.
- Governed workflows (ADR-0057): `@typesys/workflow` runs declared read,
  compute, AI, approval and Action steps through the runtime as the run's
  initiator. Registration refuses a workflow in which an AI step's answer
  can reach an Action with side effects without an approval that depends
  on it. Approvals are decided by policy (ABAC and Cedar agree) and refuse
  the initiator; the journal's append is conditional, so concurrent
  decisions cannot both land; retries apply to retryable errors only;
  compensation runs newest first; a non-idempotent Action whose outcome a
  crash lost is never repeated (the run waits for reconciliation); replay
  is checked before every advance; `simulate` previews instead of
  invoking, with scripted model answers and approvals and injected faults
  and crashes. Proven by `packages/workflow/test/` and
  `packages/devkit/test/synthesize.test.ts`, and mutation-checked. Not
  addressed: the only journal is in memory (a Postgres journal and a
  Temporal or DBOS binding are designed, not built); no durable timers or
  approval deadlines; no classification check on what is sent to a model.
- A governed HTTP API and headless React bindings (ADR-0058):
  `@typesys/http` serves the runtime over REST, one runtime call per
  request as the bearer token's caller, with RFC 9457 problems carrying a
  stable `code`, 500s that say nothing about the error, the Host and
  Origin guard shared with MCP, and an OpenAPI 3.1 contract generated from
  the model. The SDK's `httpTransport` gives the same answers as in
  process for every demo caller. `@typesys/react` adds typed hooks over
  the SDK client and form fields and table columns derived from the model;
  it decides nothing. Proven by `packages/http/test/` and
  `packages/react/test/`, and mutation-checked. Not addressed: CORS,
  ETags, streaming workflow state, nested form inputs, React 19 testing.
- Domain packs (ADR-0059): `@typesys/packs` builds a domain into one JSON
  archive with no code in it, content-addressed by SHA-256 and optionally
  signed with Ed25519. Installs are planned completely before anything is
  registered: integrity and signatures, dependency ranges, conflicts,
  unresolved references, bindings, policy rules, adapters and a scratch
  registration, with every finding reported at once. Upgrades are checked
  with the contract diff across everything installed, the version bump
  and every dependent's range. The demo domains ship as archives under
  `packs/` (drift-checked); installed from those files they are the same
  model and give the same answers as the code path. The CLI adds `typesys
  pack inspect | verify | sign | check-upgrade`. Proven by
  `packages/packs/test/` and `packages/cli/test/pack.test.ts`, and
  mutation-checked. Not addressed: workflows and sample data in packs,
  packing YAML domains, a pack registry, key revocation, uninstall.
- A subtype keeps its base's protections (ADR-0060): registration merges
  the base's property policies and markings into a subtype and applies the
  base's object policy when the subtype names none; replacing an inherited
  rule or marking is refused. Before it, a subtype naming only an object
  policy exposed every protected value it inherited. Proven by
  `packages/core/test/subtype-protections.test.ts`, and mutation-checked.
- Coalesced computed reads (ADR-0062), opt-in with `computedReads:
  "coalesce"`: within one request, computed properties' identical adapter
  reads are made once, and concurrent equality lookups become one `in`
  query split back per value, only where the adapter filters that
  property exactly. Answers are copied once and frozen. Proven identical
  to direct reads for three callers over generated fleets by
  `packages/domain-airforce/test/computed-read-coalescing.test.ts`, with
  `packages/core/test/read-coalescer.test.ts`, and mutation-checked.
  Measured: 225 maintenance calls per 200-aircraft page become 12 to 14,
  p50 20% to 30% lower; slower where lookups find nothing. Not addressed:
  batching by id or of relationships, wider fan-out than `maxConcurrency`.
- TypeS Studio (ADR-0061): `@typesys/studio` serves the governed API
  beside a browser client under a strict Content Security Policy. The
  client uses only the API, as the signed-in person: the model with
  discovery, a query editor with live validation and one-click
  suggestions, the execution plan for that caller, paged results, the
  typed SDK code for the query (`querySource`, round-tripped over 2,000
  generated queries), and Action forms that preview before they invoke
  and invoke only the previewed input after confirmation. Proven by
  `packages/studio/test/` (server, screen logic, and a Chromium run of the
  built client as two people) and `packages/sdk/test/source.test.ts`, and
  mutation-checked. Not addressed: a sign-in flow beyond pasting a token,
  workflow and aggregation screens, provenance views, model editing,
  query completion, browsers other than Chromium.
- A query the caller can read none of is refused (ADR-0049): a `never` plan
  or a classified Type above the caller's clearance throws
  `AuthorizationError`, where `query` used to return an empty page — both
  hold for every possible dataset, so the refusal says nothing about the
  data — while a denied row is still dropped silently, since an error there
  would reveal that hidden rows exist. Proven by
  `packages/core/test/query-wholesale-denial.test.ts`, including an attack
  block showing that a Type whose rows are all hidden answers exactly like
  a Type with none. Not addressed: a rule that can't plan never refuses,
  so the same policy written as a plain function gives an empty page.
- A missing object is not found (ADR-0048): `getObject`, and the source of
  `getRelationship` and `getProvenance`, raise `ObjectNotFoundError` (a
  `NotFoundError`) for an id no source holds, where they used to return an
  object with empty `values`. It is raised only after the policy decision, so
  a caller the policy denies gets the same refusal for a missing id as for a
  forbidden one; a dangling reference is left out of a relationship or
  include. Proven by `packages/core/test/object-not-found.test.ts`, including
  an id-probing attack block. Not addressed: a rule that admits an object
  with no attributes lets a caller it denies on real rows tell missing from
  denied, and a cached miss lasts until its TTL (see the ADR).
- Authorization planning (ADR-0038): a read policy's plan — `always`,
  `never`, an `eq`/`and`/`or` predicate marked exact or not with structured
  limitations, or `unknown` — is fitted to the Type's data sources and
  pushed into `query`'s adapter filter, and an exact one admits `aggregate`
  over exactly the readable rows; the post-read decision stays on every
  object. The ABAC helpers plan from the structure they evaluate;
  `rowSecurity: "require-exact"` refuses inexact plans; `explainQuery`
  reports the plan and its guarantees. Proven by differential conformance
  (`checkPlanConformance`), generated-case properties, runtime attack
  suites, and a hospital-domain equivalence suite showing planning changes no
  result. Cedar plans through partial evaluation (ADR-0039): residuals
  translated by shape, anything else weakened to `true`, exact for Types
  with declared attributes only on the `schemaConformantData` assertion;
  proven against a reference evaluator and Cedar's own decisions
  (`packages/policy-cedar/test/planning.test.ts`). Adapters say what they
  filter exactly (`canFilter`, ADR-0040), so an encrypted deterministic
  field is pushed through its blind index; the Postgres adapter compiles
  filters to parameterized SQL — exact or a re-checked superset — proven by
  a differential test against `matchesFilter` on a real PostgreSQL
  (`packages/adapter-postgres/test/sql-pushdown.test.ts`); numeric
  conditions are supersets bounded in exact decimal arithmetic, so no claim
  of exactness rests on Postgres's floating-point input (ADR-0044,
  `packages/adapter-postgres/test/numeric-bounds.test.ts`).
- Adapter-call resilience (ADR-0026): an opt-in per-call timeout with
  cooperative `AbortSignal` cancellation, retries with exponential backoff
  and jitter for idempotent reads (and only Actions whose `idempotency` is
  not `"none"`), and a per-data-source circuit breaker — all wired once into
  `SemanticRuntime.getAdapter` and off by default. The mock-REST adapter
  honors the signal on its simulated latency; the Postgres pool's default
  `max` is aligned to the concurrency budget, with an opt-in
  `PG_STATEMENT_TIMEOUT_MS` (`packages/core/test/resilience.test.ts`).
- Type-aware ESLint (`typescript-eslint` `recommendedTypeChecked`) and a
  full type-check of source, tests, and scripts (`npm run typecheck`),
  both enforced in CI, run from an isolated `tools/eslint` toolchain
  because TypeScript 7 ships no JS API for the parser.
- OpenTelemetry tracing/metrics that cost nothing unless an application
  registers a real SDK — verified both directions (ADR-0017).
- MCP server on the real SDK, stateless per-call identity, proving the
  human and AI-agent paths get identical governance. Two real transports:
  stdio (`createServer`) and Streamable HTTP (`createHttpApp`, ADR-0021),
  the latter resolving identity from a real `Authorization` header,
  verified by a real HTTP-client smoke test (`npm run smoke:mcp-http`)
  alongside the stdio one. Both serve any `{ registry, runtime }` with a
  caller-supplied resolver and name no domain (ADR-0050), proven by
  `packages/mcp-server/test/generic-backend.test.ts` over a fleet domain
  built from core alone, plus a guard that fails if the package imports or
  depends on a domain. Not addressed: a generic command-line server that
  loads a backend from a module; the demo's entry points are
  `packages/demo-web/src/mcp-stdio.ts` and `mcp-http.ts`.
- An MCP surface for tool-first agents (ADR-0051): a tool twin for each
  resource read (`typesys_list_types`, `typesys_describe_type`,
  `typesys_get_object`, `typesys_get_relationship`,
  `typesys_get_provenance`), `typesys_query` and `typesys_aggregate`, all
  returning `structuredContent` against an `outputSchema`; Action tools
  annotated from `sideEffects` and `idempotency`; the `typesys_` prefix
  reserved. Proven by `packages/mcp-server/test/agent-surface.test.ts`
  (each twin matches its resource in value, refusal, and audit rows, as
  three identities) and a hospital row-level case. The official MCP
  conformance suite runs in CI against a baseline that explains every
  expected failure (`npm run conformance:mcp`). Host/Origin validation and
  instance-scoped Actions have since landed (ADR-0053). Not addressed:
  human-approval semantics; tool discovery at scale; a full
  remote-MCP authorization mode (ADR-0051's follow-ups).
- Real OIDC/JWT identity resolution (`@typesys/auth-oidc`) — signature,
  issuer (RFC 9207), audience, and expiry verified via `jose`, scope
  claims mapped per RFC 9396, a drop-in for the demo's token map via the
  same `IdentityResolver` parameter (ADR-0018).
- A declarative YAML authoring path + `generate-types` codegen +
  `typesys init` scaffolding (`@typesys/cli`) — proven by actually
  compiling generated output with `tsc --strict`.
- The web demo makes all of the above clickable — including a Security tab
  that puts row-level access, classification, encryption at rest, and the
  two policy engines side by side, and a header switch that routes the whole
  app through either engine.
- CI (`.github/workflows/ci.yml`) builds and runs the full suite on
  every push, including a Postgres-service-container job for the
  database-gated tests.
- A latency/throughput benchmark (`npm run benchmark`) for
  `SemanticRuntime` operations against both the in-memory and
  PostgreSQL adapters — regression tracking, not a deployment-specific
  throughput SLA.
- Real publish infrastructure (package metadata, LICENSE, changesets for
  coordinated cross-package versioning, a gated `.github/workflows/release.yml`) —
  proven by a real `npm pack --dry-run` per package and `npx changeset status`
  correctly proposing bumps across the dependency graph. No package has
  actually been published to npm; the release workflow's publish step is
  gated behind an `NPM_TOKEN` secret that is not configured in this
  repository, deliberately (ADR-0020).
- 965 tests (2026-10-13): 904 run with no infrastructure, the other 61
  need PostgreSQL, Redis or a KMS emulator. Two of the 892 drive the
  Studio in Chromium and skip where no Chromium is installed. Plus stdio
  and HTTP MCP smoke tests and the MCP conformance suite, all green.

## The 2026-09-29 hardening pass: what is now proven

Four Tier-1 items from [`PRODUCTION-READINESS.md`](PRODUCTION-READINESS.md),
each with an ADR, attack tests, and a mutation check (each enforcement line
removed in turn, and a test failing for every one). What the tests
demonstrate, and nothing more:

- **Row-level authorization (ADR-0030, item 8).** A policy decides on the
  object's own stored attributes on every read path; clinician B cannot
  read clinician A's patient by `getObject`, seven query shapes, paging,
  three include paths, navigation, provenance, aggregation, or MCP, and every
  attempt is audited with no PHI in any error, reason, or audit row.
- **A real policy engine (ADR-0031, item 1).** `CedarPolicyEngine` decides
  identically to `AbacPolicyEngine` — same results, same audited decision at
  every checkpoint — across 2,422 scenarios for fifteen identities on both
  domains, and fails closed on every Cedar error at load or per decision.
- **Classification (ADR-0032, item 3).** A value, object, or derived value
  marked above the reader's clearance is unreadable through every read path,
  no policy engine can relax it, an uncleared reader never causes a
  classified object to be read, and missing or unknown labels fail closed.
- **Encryption at rest (ADR-0033, item 4).** The store holds no plaintext
  for encrypted fields in any encoding; tampering, moving, and the wrong key
  fail closed; equality works through verified blind indexes; every hospital
  read path returns the same results encrypted as not.

A review of the pass found one audit-completeness defect, since fixed:
`listActions` decided policy and clearance correctly but wrote no audit
rows. It now shares `invokeAction`'s audited gate, row-for-row, and a
tripwire test pins every call site of the non-auditing decision primitives
(`packages/core/test/audit-completeness.test.ts`).

Not proven, and listed per ADR for human review: this code is
machine-verified, not human-reviewed; the pagination inference channel for
rules that can't be planned exactly (ADR-0030, ADR-0038); Cedar's formal analysis of a real policy set (ADR-0031);
value-level markings in adapter-side aggregation and write rules (ADR-0032);
a cryptographic review (ADR-0033); the legacy-migration window (ADR-0035);
replay of an `EncryptedCache` entry within its TTL (ADR-0036); and
`AwsKmsKey` against AWS KMS itself, with real key policies and IAM
(ADR-0037).

## Real but narrow — the mechanism exists, exercised once

- Property-level policy is exercised on several fields, not just the two
  demo-domain ones (`Aircraft.maintenanceStatus`, `Patient.medicalRecordNumber`):
  a dedicated suite (`packages/core/test/property-policy.test.ts`) covers role-
  and attribute-based (ABAC) property policies across getObject redaction,
  getProvenance denial, query projection, and fail-closed filtering, with
  partial per-caller visibility.
- The query DSL covers filter, sort, projection (`select`), pagination,
  relationship includes, grouped aggregation (`runtime.aggregate()` + the MCP
  `aggregate` tool), and case-insensitive `search` / `icontains` — all
  fail-closed under property-level policy (ADR-0027, `query-sort-and-projection.test.ts`,
  `query-aggregate-and-search.test.ts`). A top-level filter may name a computed
  property (ADR-0054: that part runs in the runtime on caller-visible values,
  refilling pages up to `maxScanned` rows per call); a top-level sort still
  can't (rejected with a clear error), but include sorts can; includes nest, filter, and project
  per level (bounded by `maxIncludes`/`maxIncludeDepth`). Aggregation runs in the
  adapter's optional `aggregate` (in-memory and Postgres); a data source without
  it returns a clear `AggregationNotSupportedError`. Full-text `search` desugars
  to a uniform `icontains` substring match — native per-backend FTS (Postgres
  `to_tsvector`) is a documented per-adapter enhancement, not yet built.
- Relationship resolution is a small closed set of strategies parsed by the
  shared `parseResolution` (ADR-0028): `byForeignKey`, `byOwnField`,
  many-to-many `byJoinTable` (same-source join collection), and multi-field
  `byCompositeKey`. All three adapters consume the parsed form; the runtime
  caps fan-out at `maxRelatedPerObject` and includes take `sort` / `limit`. A
  cross-data-source join table is parsed but not yet resolved (an adapter that
  doesn't own the join throws `UnsupportedResolutionError`) — still not a
  general graph-join engine, by design (ADR-0003).
- Caching is wired and tested in isolation; the shipped demo domain
  doesn't turn it on for any real mapping (opt-in by design, per
  ADR-0016 — nothing stops you from setting `resolutionMode: "cached"`
  on your own).

## Documented as a seam, not (yet) implemented — the ADRs say this outright

- `resolutionMode: "materialized"` is supported by the model, but nothing
  populates a materialized store — there is no ingestion pipeline.
- Adapter-level tracing (a span per individual adapter call, not just
  the runtime method that contains it) is deferred — see ADR-0017's
  "Alternatives Considered."

## Correctly not built

Graph database, ETL platform, full IAM, reactive event propagation,
GraphQL, an LLM orchestration layer — all explicit
non-goals in the original mission brief
([`docs/initial_prompt.md`](initial_prompt.md)), and the architecture
leaves clean extension points for each rather than stubbing them out.

## The pattern, if you're deciding whether to extend something here

Every "documented as a seam" item above follows the same shape: a small
interface (`Cache`, `PolicyEngine`, `RegistryStore`, `Adapter`) with one
built implementation and a clear place a second, more capable one would
slot in without touching `SemanticRuntime`. If you need one of these
seams filled in for real, that's usually a contained, well-bounded piece
of work — read the matching ADR's "Alternatives Considered" section
first; it likely already named the tradeoff you're about to make.
