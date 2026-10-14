# M2 adversarial review (PR #14, head bbe0010)

Reviewed 2026-10-14 by an independent thread. Scope: ADR-0065 (continuing authority, durable timers), ADR-0066 (Postgres journal), ADR-0067 (release to models), ADR-0068 (discovery modes), ADR-0069 (pack revocation). The aim was to break each ADR's "Proven by" invariants, not to re-run its tests.

**Result: 27 confirmed defects (6 High, 11 Medium, 10 Low).** Every one has a test on branch `claude/m2-adversarial-review-7ue92y` that asserts the secure behavior and fails on bbe0010. No `src` file was changed. The PR's own 305 tests in the affected packages pass, and the 10 Postgres journal tests ran against a real Postgres 16 (not skipped).

Repro test files (all named `m2-adv-*.test.ts`):

| File | Fails | Passes (attacks that held) |
|---|---|---|
| `packages/workflow/test/m2-adv-authority.test.ts` | 11 | 0 |
| `packages/workflow-postgres/test/m2-adv-postgres.test.ts` (needs `DATABASE_URL`) | 3 | 3 |
| `packages/workflow/test/m2-adv-release.test.ts` | 5 | 1 control |
| `packages/http/test/m2-adv-release.test.ts` | 1 | 0 |
| `packages/domain-hospital/test/m2-adv-release.test.ts` | 1 | 0 |
| `packages/domain-airforce/test/m2-adv-release.test.ts` | 1 | 1 |
| `packages/policy-cedar/test/m2-adv-release.test.ts` | 0 | 4 |
| `packages/core/test/m2-adv-discovery.test.ts` | 5 | 1 sanity |
| `packages/mcp-server/test/m2-adv-discovery.test.ts` | 7 | 0 |
| `packages/packs/test/m2-adv-revocation.test.ts` | 6 | 0 |
| `packages/cli/test/m2-adv-revoke.test.ts` | 1 | 0 |

Reproduce: `npx tsc -b --force && DATABASE_URL=postgres://… npx vitest run $(git ls-files 'packages/*/test/m2-adv-*.test.ts')` gives 41 failed, 10 passed.

Line numbers are at bbe0010.

## High

### H1. A model-bound caller reads a run's outputs as the person read them (ADR-0067)
`packages/workflow/src/engine.ts:416-420`. `outputs()` checks only that `identity.subjectId` is the initiator and ignores `identity.audience`, so `GET /api/workflow-runs/:id/outputs` returns the journaled reads unchanged. With one engine behind a UI API and an agent API bound to the commercial model, the agent's direct read of the Aircraft is refused (403) but the outputs route returns it, SECRET `deploymentLocation` included.
Repro: http "a commercial-model agent reads a run's outputs, SECRET location included, though it may read no Aircraft" (observed `{ status: 200, leaksLocation: true }`). workflow "outputs() of a run are not decided for the audience the caller reads for".
Fix: when the caller carries an audience, decide outputs for it (re-read as the bound identity, or refuse).

### H2. Re-resolving a run's identity drops its audience (ADR-0065 × ADR-0067)
`engine.ts:500-515` (`currentAuthority`). `resolveIdentity(held)` returns the plain person and only `subjectId` is compared, so a run started by `withAudience(maintainer, enclaveModel)` reads and acts as the person alone from its first advance on. The two M2 features cancel each other out.
Repro: workflow "a run started by an identity bound to a model keeps reading for that model after its identity is re-resolved" (the output carries `deploymentLocation: "FOB ALPHA (exercise designation)"`). The control without a resolver passes.
Fix: re-apply `held.audience` after resolution (in `reauthorize` and `cancel` too), and suspend if the resolved identity names a different audience.

### H3. `when` conditions leak withheld values to the model (ADR-0067)
`releaseInput`/`releasedOutput`, `engine.ts` around 799-845. The release replay re-runs computes but never re-decides a step's `when` on released data, and a skipped step stays skipped. A compute `atFob` with `when: location.startsWith("FOB")` and `run: () => true` recomputes to the same value, so the comparison finds no difference and the model receives a predicate over the SECRET value. An AI step's own `when` (around line 632) is decided on the person's data, so whether the model is called at all depends on the SECRET value. Repeated, either one extracts the value bit by bit.
Repro: workflow "a `when` condition over a SECRET value is not re-decided for the model…" (the model received `[{atFob:true},{atFob:false}]` for a FOB aircraft and a home-station one). Workflow "an AI step's own `when` over a SECRET value decides whether the model is called at all".
Fix: re-evaluate each upstream step's `when`, and the AI step's own, on the released context, and treat a difference from the journaled decision as withheld (refuse, or redact).

### H4. `previewAction` ignores discovery mode (ADR-0068)
`packages/core/src/runtime/runtime.ts:2160`. Unlike `listActions` (around 2119), it never checks `discovery` or `isAnonymous`. Under need-to-know, a viewer and an anonymous caller both get HTTP 200 from `POST /api/actions/:name/preview` (and MCP `typesys_preview_action`) with the withheld Action's version, preconditions, side effects and idempotency, plus a blocker naming the policy's roles: "Requires one of roles [maintainer, ai-enclave], subject has [viewer]".
Repro: core "previewAction does not tell an anonymous caller about an Action…" and "…a viewer a withheld Action's preconditions, effects or the roles its policy wants". mcp-server "REST/MCP: preview of a withheld Action…" and "REST: an anonymous caller is refused previewAction in need-to-know…".
Fix: refuse as `listActions` does, and answer a refused caller exactly as for an unknown Action.

### H5. MCP Type documents name a withheld base Type through `allOf` (ADR-0068)
`packages/mcp-server/src/reads.ts:25`. The code removes five `x-` keywords by denylist and leaves the rest. For the viewer under need-to-know, `airforce.Aircraft` comes back with `"allOf":[{"$ref":"https://typesys.dev/types/core/Asset/1.0.0"}, …]`, although the runtime withholds `extends: core.Asset`. The existing test looks only for the dotted name. `traits` (line 37) is also not narrowed.
Repro: mcp-server "typesys_describe_type does not name the viewer's withheld base Type core.Asset (schema.allOf $ref)".
Fix: build the MCP document from the narrowed `TypeDescription`, using an allowlist of keywords.

### H6. Cancelling orphans a non-idempotent Action whose outcome was never recorded (ADR-0065/0066)
`cancel()` at `engine.ts:368-397` and `compensate()` at around 852. Compensation undoes only steps whose outcome is `completed`, and `cancel` skips the in-flight check that advance makes at around line 654. Two observed cases:
- After a crash mid-Action, cancelling reports `cancelled` while the work order stays open.
- Process B cancels while process A is inside `CreateMaintenanceWorkOrder`. A's `step-completed` loses the conflict, and the run ends `cancelled` with the order `open`.

In both cases the run claims a clean undo it did not make.
Repro: workflow `m2-adv-authority` "cancel after a crash mid-Action…" and "cancel racing a process that is mid-Action…" (observed `{ cancelStatus: 'cancelled', final: 'cancelled', orders: ['open'] }`).
Fix: an in-flight or indeterminate non-idempotent Action makes cancellation end `needs-reconciliation`.

## Medium

**M1. In-process retries skip the authority check.** `engine.ts:690-732`. Authority is checked once per step, not before each attempt, so a token that expires during the inline backoff still drives the second attempt. Observed `completed`, 2 attempts; expected `suspended`. Repro: "an in-process retry of an Action after its backoff must not run on credentials that expired during the backoff". Fix: call `stillAuthorized` before every attempt after the first.

**M2. A run suspended while compensating cannot be cancelled.** `engine.ts:371` refuses cancel for any compensating run, and `compensate()` can suspend mid-undo. If the initiator is gone, the completed Action is never undone even with a `cancelPolicy`, contrary to ADR-0065 ("ends by cancellation"). Observed "Run … is already being undone", order still open. Repro: "credentials expiring during compensation leave a run nobody but the (gone) initiator can finish undoing". Fix: let an admitted canceller take over a suspended compensation.

**M3. One bad run stops `tick()` and `resumeAll()` for every run.** `engine.ts:331-335` and 313-315 swallow only `JournalConflictError`. A transient resolver error for one initiator left another run's approval unexpired past its deadline. A `runs` row with no events made every `tick` throw `NotFoundError`. Repro: "a transient resolver error for one initiator stops tick() from expiring another run's approval". Fix: isolate errors per run inside the sweeps.

**M4. Approval deadlines are not validated.** `validate.ts` never checks `deadline.afterMs`. NaN, Infinity and negative values all register. A non-finite one journals a run that then throws `RangeError: Invalid time value` (`engine.ts:642`) in every later `resumeAll`. A negative one expires every approval at once. Repro: four tests under "approval deadlines are validated". Fix: require `Number.isFinite(afterMs) && afterMs > 0`.

**M5. `deprecated.supersededBy` names withheld Types and Actions.** `packages/core/src/runtime/discovery.ts:121-130` spreads `deprecated` unnarrowed (Actions at :73). The devkit validator then suggests the withheld name (`packages/devkit/src/validate.ts:73`), and MCP copies it (`reads.ts:50`). Repro: core ×2 and mcp-server ×2 "…supersededBy…", "typesys_validate_query does not suggest a withheld Type". Fix: drop `supersededBy` unless its target is described.

**M6. MCP relationships send `inverseName`, which can name a withheld relationship.** `reads.ts:45`. Output contains `handlerOfRecord`, which the viewer is withheld. Repro: mcp-server "…through another one's inverseName". Fix: omit unless that member is described.

**M7. REST refusals send the policy reason, naming the required roles, under need-to-know.** `packages/http/src/problems.ts:62,70`. Viewer invoking `CreateMaintenanceWorkOrder` gets 403 with "Requires one of roles [maintainer, ai-enclave], subject has [viewer]". MCP sends only "Not authorized". Repro: mcp-server "REST: a viewer refused a withheld Action is not told which roles its policy wants". Fix: omit `reason` when discovery is not `open`.

**M8. "Not releasable" is an existence oracle for the model.** `runtime.ts:862` and `decideForIdentity`. The person is decided first, so "Not releasable to …" appears exactly when the person may read the row. A model bound to clinician PR-2001 learns PT-1001 exists and is assigned to its user, while PT-1002 and the nonexistent PT-9999 get the plain reason. Repro: domain-hospital "the model cannot tell, from the refusal, which patients exist and are assigned to its user". Fix: one uniform refusal when an audience is bound, with the detail in the audit row only.

**M9. Stripping the revoked key's signature defeats the co-signing rule.** `packages/packs/src/archive.ts:262-266`. Signatures are outside the digest, and a signature under an unknown key id is skipped. A pack co-signed by revoked `wing-2025` and `depot` is refused as shipped, but verifies (`[]`) once the `wing-2025` entry is dropped or its keyId becomes `"wing-2025 "`. ADR-0069's claim that "co-signing no longer lets a good key launder a pack" does not hold against the revoked key's holder, who is the adversary revocation targets. Repro: packs "a co-signed pack is still refused after the revoked key's holder strips (or renames) its own signature". Fix: state this as a limit in the ADR, or bind the signer set into what each key signs.

**M10. A revoked installed pack is caught only if the caller lists it.** `packages/packs/src/install.ts:235` checks `opts.installed`, not the registry. Observed: with the wing-signed airforce pack installed and `wing-2025` revoked, `installPacks([hospital], { installed: [core], revokedKeys })` succeeds. Repro: packs "an install while a revoked pack is in the registry is refused even when the caller leaves it out of `installed`". Fix: record installed packs and digests in the registry and check against that record.

**M11. Not every install attempt is audited.** A malformed `archives` entry (`install.ts:306`) or `installed` entry (:235) throws before any row is written. A failure while registering leaves Types registered and no row (:322-323). Repro: three packs tests "installPacks … audit row …". Fix: `try`/`finally` writing a deny or error row on every exit.

## Low

**L1. The append-only trigger misses TRUNCATE.** `packages/workflow-postgres/migrations/0001_workflow_journal.sql:28-30`. Observed `{ truncated: 'truncated', left: 0 }`. Fix: a `BEFORE TRUNCATE` statement trigger, and revoke TRUNCATE.

**L2. The `runs` table is unprotected.** Same migration, lines 5-11. Setting `finished = true` hides a run from `unfinished()` (`postgres-journal.ts:91`), so its deadline never fires (observed `waiting-approval` after the deadline and a tick). Fix: a trigger that allows only monotonic `length` and a false-to-true `finished`, and refuses DELETE.

**L3. The Postgres journal rejects NUL characters.** `postgres-journal.ts:51` (JSONB refuses `\u0000`; the in-memory journal accepts it). An Action output with NUL would fail the `step-completed` append after the effect happened. Fix: add NUL to `workflowJournalContract`, and encode it.

**L4. An expired canceller's refused cancel is audited as allow.** `engine.ts:383-389` audits before the expiry check and never audits the refusal. Fix: check expiry first and audit deny.

**L5. `identityMaxAgeMs: NaN` disables the age limit** (`engine.ts:511-512`, `age > NaN` is false). A run still completed a week later. Fix: validate the option as finite and ≥ 0.

**L6. The `invokeAction` outcome audit row omits the audience.** `runtime.ts:2275-2284` calls `appendAuditEvent` directly, bypassing `audit()`. This contradicts ADR-0067's "every audit row of a bound identity carries `details.audience`".

**L7. Workflow audit rows omit the audience** except `workflow.release` (`engine.ts:178`, `audit()` at 568).

**L8. Revocation is by key id, not by key.** The same public key trusted under another id still verifies (`archive.ts:264`, 306). Fix: match revocations by key fingerprint too.

**L9. `pack verify --revoke` fails open on how a digest is spelled.** `packages/cli/src/bin.ts:328-329`. `--revoke SHA256:<hex>` printed `ok: true`, exit 0. Fix: normalise digests and reject a malformed value.

**L10. `isAnonymous` treats an identity with no `subjectId` as authenticated** (`discovery.ts:25`). In `authenticated` mode such an identity gets the whole model. No resolver in the repo produces one today.

## Seen in code, not demonstrated

- `invokeAction` over MCP and HTTP returns an Action's result to a bound agent without deciding it for the audience. The ADR concedes this only for workflow AI steps. The demo Actions return data the enclave model may read anyway.
- `asSeenBy` passes compute and AI outputs to an approver unchanged. No demo audience can approve.
- Nothing stops a person from holding `ai-enclave`, and OIDC copies all token claims into attributes. A model with no audience is named `model:<id>`, which a rule granting by id could match on a spoofed id.
- No shipped host calls `bindAudience`; the demo's stdio MCP server binds none, so ADR-0067's protection is opt-in per host.
- Pack audit: an audit failure on the deny path replaces the `PackError`, and on the allow path it throws after registration. `signedBy` lists claimed, not verified, key ids. `actor` is caller-supplied (no transport exposes installs).
- Two services registering the same workflow name and version on a shared journal can advance each other's runs.

## Attacks that held

- **ADR-0065 authority:**
  - A different subject, fewer roles, or a missing, null, NaN or numeric `expiresAt` suspends the run, failing closed.
  - The age limit uses the injected clock against the journaled time.
  - `reauthorize` by another subject is refused and audited, and it cannot switch the run's role.
  - A canceller can only undo. Double cancel, cancel after finish and cancel during compensation are refused.
  - A decision exactly at the deadline is refused, consistently in `approve` and `tick`.
  - `tick` skips suspended runs.
  - Concurrent `tick`/`resume`/`approve` across two engines never duplicate an effect.
  - Foreign workflows are skipped by name@version.
- **ADR-0066 Postgres:**
  - 40 writers across two pools at one length produce exactly one winner, and 40 concurrent starts produce exactly one.
  - Run ids are parameterised.
  - JSONB round-trips keep `canonical()` equal for -0, 2^53, 1e21, 1e-7, key order, undefined members and Dates.
- **ADR-0067 core conjunction:**
  - These all decide for both principals: `getObject`, `query` (pushed-down `allPlans`, residual computed filters), `search`, `aggregate`, relationships and includes, `getProvenance`, Action previews and invocation preconditions, `listActions` and `describeModel`. No direct engine call and no cache keyed on the person was found.
  - `allPlans` handles never, always and unknown correctly.
  - Cedar and ABAC agree for hospital identities bound to audiences (query ids and counts).
  - `bindAudience` overrides a forged same-id audience and refuses a different one.
  - An AI step downstream of an Action is refused at registration, transitively.
  - `simulate` releases as a live run does.
- **ADR-0068:**
  - `HIGH_ASSURANCE_V2` supplies need-to-know and refuses `open`, and an unknown mode throws.
  - MCP over HTTP builds the server per request from the bearer, so nothing is cached.
  - `typesys_invoke_action` goes through `invokeAction`.
  - `/model`, `/openapi.json`, `/discover` and `/query/validate` all call `describeModel`, which audits one row per call.
  - The read error oracles found are the ones the ADR already admits.
- **ADR-0069:**
  - Prototype-named key ids are not matched as revoked.
  - A bad signature from a trusted key refuses the pack.
  - A withdrawn digest stays refused after re-signing.
  - `checkUpgrade` registers only into a scratch registry.

## Disposition (2026-10-14)

All 27 findings are fixed on the same branch. Each review test now passes,
and each fix has a mutation in [`tools/mutation/catalog.json`](../../tools/mutation/catalog.json)
that the review's test kills (`npm run mutation`; the evidence names the
revision it ran on). The ADRs record what changed, in an "Amended after the
independent review" section of each.

| Finding | Fix | Mutation |
|---|---|---|
| H1 run outputs | `outputs()` refuses an audience the run did not read for | `release.outputs-ignore-audience` |
| H2 re-resolution drops audience | the run's audience is re-applied; a different one suspends | `release.reresolve-drops-audience` |
| H3 `when` leaks | upstream `when` re-decided on the model's view; AI step's own `when` too | `release.when-not-redecided`, `release.ai-when-not-redecided` |
| H4 previewAction | follows the discovery mode; withheld reads as unknown | `discovery.preview-anonymous`, `discovery.preview-withheld` |
| H5 MCP `allOf` | allowlisted keywords; `allOf` narrowed | `discovery.mcp-allof-names-base` |
| H6 cancel orphans an Action | in-flight or indeterminate Action ends `needs-reconciliation` | `authority.cancel-claims-clean-undo` |
| M1 retry authority | checked before every in-process retry | `authority.retry-skips-recheck` |
| M2 suspended undo | an admitted canceller takes it over | `authority.suspended-undo-uncancellable` |
| M3 sweeps | each run on its own; failures thrown after | `authority.sweep-stops-on-one-run` |
| M4 deadlines | `invalid-deadline` at registration | `authority.deadline-unchecked` |
| M5 `supersededBy` | dropped unless described | `discovery.superseded-by-withheld` |
| M6 `inverseName` | only when described | `discovery.mcp-inverse-names-withheld` |
| M7 REST reasons | withheld unless discovery is `open` | `discovery.rest-sends-reasons` |
| M8 refusal oracle | one reason for an audience caller | `release.refusal-names-cause` |
| M9 stripped co-signature | signatures bind earlier signers | `packs.cosigners-unbound` |
| M10 unlisted installed pack | installs recorded in the audit trail and checked | `packs.recorded-installs-unchecked` |
| M11 unaudited installs | audit row in `finally` | `packs.failed-install-unaudited` |
| L1 TRUNCATE | refused by trigger | `journal.truncate-allowed` |
| L2 runs table | follows the events table by trigger | `journal.finished-behind-its-back` |
| L3 NUL | encoded; in the journal contract | `journal.nul-unencoded` |
| L4 cancel audit | expiry first, audited `deny` | `authority.expired-canceller-proceeds` |
| L5 NaN max age | refused at construction; comparison fails closed | `authority.max-age-unvalidated` |
| L6 Action outcome audit | carries the audience | `release.action-outcome-without-audience` |
| L7 workflow audit | carries the audience | `release.workflow-audit-without-audience` |
| L8 revocation by name | by key fingerprint too | `packs.revoked-by-id-only` |
| L9 digest spelling | normalised; malformed refused | `packs.revoke-digest-misspelled` |
| L10 no subject | anonymous | `discovery.no-subject-authenticated` |

Three review tests were adjusted, each because the fix chose a different
secure behavior from the one the test assumed. The `when`-laundering test
declares `release: "redact"`, since the default refusal fails that run,
which is also secure. The NaN `identityMaxAgeMs` test expects the engine to
refuse to build. The poisoned-sweep test journals the poisoned run directly,
since registration now refuses the definition that made it.

The items under "Seen in code, not demonstrated" remain open. ADR-0067
lists those about release. The others (pack audit failure handling,
`signedBy` listing claimed key ids, a caller-supplied `actor`, two services
sharing a workflow name on one journal) are recorded in
[`docs/completeness.md`](../completeness.md).

