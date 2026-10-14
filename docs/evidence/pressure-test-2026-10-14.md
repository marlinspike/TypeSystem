# Pressure test of the composition platform (2026-10-14)

An independent adversarial review of ADR-0052 to ADR-0063 as first written (pull request #11), and the fixes (pull request #12), both merged. This is the review as written; line numbers refer to the reviewed commit.

Reviewed: `claude/typesys-composition-8uta1a` at 2c532d5. Fixes: pull request #12, merged into that branch before it reached main. Every finding below has a test that failed on 2c532d5 and passes with the fixes (`packages/*/test/pressure-*.test.ts`, plus a few additions to existing test files).

**Result in one paragraph.** The baseline reproduces (clean forced build: 919 pass / 61 skipped, lint, typecheck, MCP smoke, SDK-model and pack checks all green), and almost every number in the evidence docs held up. But adversarial testing found 50 failing cases behind roughly 35 distinct defects. Four are high severity: a workflow's AI step could skip its own human review or invoke Actions from a read step (also inside `simulate()`), a computed property could read any field it never declared (defeating ADR-0052 and ADR-0060), a pack could silently overwrite existing Types and data sources, and `checkUpgrade` called a pack that strips policies and SECRET markings a safe patch. All are fixed. After the fixes: 992 pass / 61 skipped across 124 files, lint, typecheck, `smoke:mcp`, `sdk:models --check` and `packs --check` are green.

## High

| # | Finding | Root cause (2c532d5) | Repro | Fix |
|---|---|---|---|---|
| H1 | An approval's `when` could read the AI answer and skip the review; the model alone opened and started a work order. | `packages/workflow/src/validate.ts:70-81` ignores `when`; `engine.ts:366` skips | `pressure-workflow.test.ts` "approval whose `when` reads the AI output…" | Validator counts an approval only if unconditional or sharing the AI step's condition; engine and replay never skip an approval downstream of an AI step that ran |
| H2 | A read step's SDK client could `invoke` side-effecting Actions: no review, no journal protection, retried. | `workflow/src/engine.ts:444-446` gives a full client | "a read step cannot invoke…" | Read steps get a transport whose `invokeAction` throws |
| H3 | `simulate()` changed real data through that same path (work order created, `invokeAction` audited). | same, `simulate.ts:153` only overrides action steps | "…inside simulate()" | same fix |
| H4 | A computed property could read any stored value, including policy-hidden ones, by not listing it in `dependsOn`; a subtype could use this to read a base-protected field (ADR-0060's "cannot widen access… on purpose" did not hold). | `core/src/runtime/runtime.ts:1160` `getProperty`; gate at :1206 checks only declared inputs | `pressure-core-enforcement.test.ts` two `[FINDING]` tests | Per-property context; undeclared names read as `undefined` |
| H5 | `installPacks` overwrote Types/data sources already in the registry (an unsigned pack redefined `airforce.Aircraft` with no policy and pointed its data source at another host). | `packs/src/install.ts:115-121,182-202` never consults the target registry | `pressure-packs.test.ts` "refuses a pack that redefines…" | Conflicts checked against the registry; packs may only define Types in their own namespace |
| H6 | `checkUpgrade` (and `typesys pack check-upgrade`, exit 0) passed a patch that removed a property policy, a SECRET marking and loosened an Action policy. | `packs/src/upgrade.ts:78-110` diffs only `describeModel`, which omits all protections | two tests in `pressure-packs.test.ts` | New `protection-weakened` diagnostic over raw pack contents |

## Medium

| # | Finding | Root cause | Fix |
|---|---|---|---|
| M1 | Action preconditions saw raw (unredacted) values; `previewAction`'s per-precondition `satisfied` was a repeatable one-bit oracle on hidden fields (also via `invokeAction`'s error). | `runtime.ts:1867-1876` | Preconditions get caller-visible values; one that reads a withheld value is undecided (`satisfied: null`, invoke refused) |
| M2 | `explainQuery` had no clearance/readability gates, and its plan is now exposed over HTTP and MCP: an UNCLASSIFIED caller got the plan for a SECRET Type. | `runtime.ts:1548-1585` | Same gates as `query`; includes the caller can't see are dropped from the plan |
| M3 | `releases` on a computed input transitively released that input's own protected inputs. | `runtime.ts:1206-1214` | A release lifts only the named input's own policy |
| M4 | An approver saw objects read with the initiator's rights (a CUI-cleared lead saw the SECRET `deploymentLocation`). | `workflow/src/engine.ts:197-205` | Objects in presented outputs are re-read as the approver |
| M5 | A side-effecting compensation fed by AI output was never review-checked. | `validate.ts:70` | Same rule for `compensate.action` |
| M6 | A non-idempotent Action that wrote and then timed out ended `failed`, not `needs-reconciliation`. | `engine.ts:423-428` | Retryable failure of an idempotency-`none` Action ends as `needs-reconciliation`, also after restart |
| M7 | Bad JSON, oversized bodies and unknown `/api` routes returned Express HTML pages with stack traces and server paths (HTTP API, Studio, both mission apps). | `http/src/api.ts:58`, no error middleware | RFC 9457 400/413/404 problems |
| M8 | A token the resolver rejects (expired JWT) was a 500 logged as a server fault. | `api.ts:62` | 401 `unauthorized` + `WWW-Authenticate` |
| M9 | Anyone, anonymous included, could read any run's status (initiator, steps, recorded errors). | `api.ts:109`, `engine.status` | Initiator or admitted approver only; others get 404, like a missing run |
| M10 | React hooks kept the previous caller's data after the signed-in client changed. | `react/src/resource.ts:29-35` | New resource per client |
| M11 | `diffModels` missed breaking changes: required→optional, number→integer, added maxLength/pattern/minimum, `additionalProperties: false`, format, alias removal. Feeds `checkUpgrade` and `typesys diff`. | `devkit/src/diff.ts:46-134` | Structural constraint and `required` comparison |
| M12 | A subtype did not pick up protections its base added in a later version. | `core/src/registry/registry.ts:139,155` | Subtypes re-derived on base upgrade; conflicting upgrade refused |

## Low

`getProvenance` returned provenance for a value withheld by a marking (runtime.ts:1822); a schema-invalid computed value failed the whole read before redaction, an error oracle (:1171); a forged scan cursor set an unbounded adapter page size (:1458); `allowedHosts: "*"` also disabled the Origin check (`http/src/guard.ts:51`); Host parsed as a URL so `evil.example@localhost` passed (guard.ts:7); `/query/validate` and OpenAPI ignored `queryLimits`; SDK `httpCall` threw `SyntaxError` on non-JSON errors; `querySource` pasted untrusted operators/limits into generated code; unknown run ids were 409; `GET /workflow-approvals` wrote a deny audit row per waiting run per request; API responses lacked `nosniff`/`frame-ancestors`; `validateQuery` accepted `constructor`/`toString`; duplicate definitions inside one pack went unreported; a `keyId` of `constructor` crashed `verifyPack`. All fixed.

## Evidence claims

**Held:** baseline 725/61 and branch 980 (919 + 61) test counts; the four Chromium tests really run (here and in CI on 2c532d5); CI green including Postgres; DNS-rebinding conformance; 12 `@ts-expect-error` cases; coalescing 225 → 13-14 calls and 19-31% p50 drop; devkit byte sizes; workflow/querySource/pack sizes; mission app 193 vs 355 lines, seeded-mistake table and "follows a policy change with no edit" reproduce exactly.

**Did not hold:**
- ADR-0060 "a subtype cannot widen access to anything it inherits, by accident or on purpose" (H4).
- ADR-0053 calls precondition inputs "already-authorized" values; they were raw (M1).
- ADR-0057's claims that AI output cannot reach a side effect without approval and that simulation changes nothing (H1-H3).
- ADR-0059's "full pre-install validation" and safe-upgrade verdicts (H5, H6).
- `explainQuery`'s doc comment "runtime-only by design, never an MCP tool"; it is exposed over MCP and HTTP (M2).
- Mission "0 vs 4 wire types kept by hand": the composed client still hand-writes one shape (`a.presented as {…}` in `Approvals`).

**Held with caveats:** "0 vs 7 restated access rules" counts `// ACCESS:` comments the author placed (4 distinct rules marked 7 times), and the composed app's 136-line workflow is counted in neither total; two of the three "silent" seeded mistakes cannot surface by how the scenario is built; "same latency" holds loosely (composed p95 20.5 vs 14.4 ms here). Studio evidence (1,013 lines, 65-line server) is stale after ADR-0063 (now 987 / 38).

**Unverifiable:** all eleven mutation counts (no harness or log committed); the `getObject` "0.10 vs 0.078 ms" regression (compares two machines; same-machine runs show 0.127-0.139 vs 0.121-0.132); HTTP, Studio, workflow-engine and pack latency figures (no script).

**Mutation sample** (9 security-relevant mutations, each with `tsc -b --force`): 8 caught. The survivor was a CSP widened to an external script origin (`http/src/client.ts:11`); `apps.test.ts:66` compares the header to the constant itself. `studio.test.ts` now fails on any non-self source.

## Left open (design, not fixed)

Workflow steps act with the initiator's identity as of start unless `resolveIdentity` is given (documented, fails open on revoked roles). Model, OpenAPI, discover and `typesys_list_types` show the whole model, `x-policy` included, to anonymous callers (pre-existing on main, by design). A subtype may still name a looser object policy (documented in ADR-0060). `auth-oidc/src/oidc-identity-resolver.ts:76` maps any JWT without `sub` to subject `"unknown"` (seen in passing, not reproduced). Behaviour changes from the fixes: computed properties reading undeclared names now get `undefined` silently (typos no longer error); registering a base version can rewrite or refuse subtypes; packs may define Types only in their own namespace; a cursor whose skip exceeds `maxScanned` is refused.
