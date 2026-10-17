# TypeSystem 4.0 pressure test (compiler, app, ui, cold chain)

Reviewed: `claude/typesystem-4-compiler-03fhfh`, commits 40630e6..9ee8185 (ADR-0079 to ADR-0087), 2026-10-17.
Reproductions live in `packages/compiler/.work/pressure-1/` (gitignored; `t*.ts` scripts, run with `npx tsx packages/compiler/.work/pressure-1/<file>` from the repo root). No tracked file was changed.

**Summary: 26 findings. 4 High, 14 Medium, 8 Low.** 25 reproduced; P4-24 shown from code and marked inferred.

Checked and found sound: the HTTP adapter's new `aggregate` honours the runtime's row filter (a carrier sees only its own carrier group `n:3`; an `or` filter narrows to `n:2`; logistics sees all three). AI-step model release re-reads aggregates/relationships as the audience and refuses (`ReleaseRefusedError`) rather than leaking. `Resource` drops superseded responses. MCP `insideRoot` refuses `..`/symlink escapes for tool path arguments. `maybe-skipped` fires for required action inputs fed by a `when`-guarded step.

---

## P4-01 High: `design.system` is emitted into the client unescaped — code injection and arbitrary file import

**Where:** `packages/compiler/src/emit/pages.ts:456-473` (`appSource`); parser `packages/compiler/src/parse.ts:49`; the checker never inspects `design`.

**What is wrong:** When `design.system` contains `#`, the compiler splits it and emits `import * as <alias> from "../extensions/<left>.js";` and `overrides: <alias>.<right>`. The left half goes verbatim into an import specifier; the right half goes verbatim into a JS expression position. The parser only checks `design.system` is a non-empty string; the checker does not look at `design` at all. So a crafted `app.json` string can (a) break out of the `overrides: …` expression and have arbitrary statements emitted into `app.tsx` (which then bundle and run in every viewer's browser, defeating ADR-0082's "nothing injects script" and the app's `style-src 'self'` intent), and (b) use `..` in the module half to import any file reachable from the app dir.

**Repro** (`t2.ts`, `t21.ts`): set `design.system` to a string of the form `theme#overrides }, <arbitrary statements> ; mountApp({ … system: "meridian"`. `compile` returns ok with no diagnostics; `build` succeeds; the bundled `dist/client/app.js` contains the injected statements (`bundle contains the injected fetch: true`). Traversal form `"../../../../../../etc/passwd-like#X"` emits `import * as … from "../extensions/../../../../../../etc/passwd-like.js"` with `compile ok: true`.

**Fix:** validate `design.system` in the checker against `^(meridian|ledger)$` or `^[a-z][a-z0-9-]*(\/[a-z][a-z0-9-]*)*#[A-Z][A-Za-z0-9]*$` (the same shape `custom`/`fn` already enforce), run `known()` over design keys, and resolve the module through `extensionExists`. Emit the export name as a checked identifier, not interpolated text.

## P4-02 High: a `typesys.lock.json` entry deletes files outside the application root

**Where:** `packages/compiler/src/compile.ts:196-201` (edit check), `:225-229` (removal of stale owned files), `:230` (lock written back).

**What is wrong:** Owned-file paths from the lock are joined to the app dir and used directly. The "removed" pass runs `rm(path.join(abs, file), { force: true })` for every lock key not generated this compile. A key like `../../victim.txt` therefore deletes a file outside the app. Nothing confines lock keys to the app directory, and the edit-detection pass happily matches a hash for the out-of-tree file so the compile proceeds.

**Repro** (`t3.ts`, case a): after a normal compile, add `"../../victim.txt": <sha of its contents>` to the lock and recompile.
```
(a) ok true removed [ '../../victim.txt' ] victim exists: false
```
The file outside the app was deleted and reported under `removed`.

**Fix:** reject (or ignore) any lock key that is absolute or escapes the app root — reuse `insideRoot(abs, file)` before reading/removing — and treat a lock with such a key as corrupt.

## P4-03 High: deleting `typesys.lock.json` silently overwrites hand-edited generated files

**Where:** `packages/compiler/src/compile.ts:194-217`, `readLock` `:237-244`.

**What is wrong:** The hand-edit guard (`edited-generated-file`) runs only over files listed in the lock. `readLock` returns `undefined` for a missing or unparsable lock, and the edit loop then iterates nothing, so every owned file is overwritten without warning. ADR-0083's promise ("a hand edit to an owned file stops the compile") depends entirely on a file that is itself in the working tree and trivially lost (a `git checkout`, a merge, a `rm`).

**Repro** (`t3.ts`, case b): append a line to a generated page, delete the lock, recompile.
```
(b) ok true written [ 'src/generated/pages/Board.tsx' ] edit kept: false []
```
The edit was discarded with no diagnostic. (Case c: if a person pre-writes a page file whose page is newly added — no lock entry — it is likewise overwritten: `(c) … work kept: false`.)

**Fix:** when no lock exists but owned files do, re-hash the files present and still refuse to overwrite any whose content differs from what this compile would write unless `--force`; or keep the spec/file hashes somewhere a routine checkout will not drop, and treat a missing lock beside existing generated files as "unknown, do not overwrite without --force".

## P4-04 High: an aggregate read presented at an approval leaks a classified total to an approver not cleared for it

**Where:** `packages/compiler/src/emit/flows.ts:120-128` (approval `present`), `packages/workflow/src/engine.ts:263,297-307` (approver redaction `seenBy`), `packages/compiler/src/check.ts` (no block on presenting an aggregate).

**What is wrong:** The approver view (`seenBy`/`redact`, engine.ts:283-307) only redacts values that look like objects with `$id`+`$type`. An aggregate read returns `[{ key, values }]` — plain numbers with no `$id` — so it passes through untouched. The runtime's own `aggregate` enforces a type-level clearance gate (only a subject cleared for the Type's markings gets the sum), but the workflow re-presents the *journaled* aggregate to the approver without re-deciding it as that approver. So a `sum` of a CONFIDENTIAL field computed as a cleared initiator is shown verbatim to a less-cleared approver. The checker does not warn when an aggregate (or any non-object derived total) is listed in an approval's `present`.

**Repro** (`t6.ts`, cold chain): a flow reads `aggregate sum(unitCost)` as QA (CONFIDENTIAL), approval presents it, `pendingApproval` as `logistics` (INTERNAL):
```
approver (logistics, INTERNAL) is shown: {"lot":{…no unitCost…},"exposure":[{"key":{},"values":{"value":3445}}]}
logistics asking the runtime directly: AuthorizationError Not authorized: read coldchain.Lot/unitCost
```
Logistics is refused the raw field by the runtime but is shown the CONFIDENTIAL sum through the approval. The object field `unitCost` is correctly stripped; the aggregate derived from it is not. `t7.ts` confirms the compiler emits exactly this shape with no diagnostic.

**Fix:** in the engine's approver view, a value that is not re-derivable as the approver (an aggregate, a compute over withheld inputs) must be dropped unless it can be recomputed as the approver and matches. At minimum, re-run an aggregate step's read as the approver when presenting it. In the checker, warn (or refuse) when an approval presents an aggregate step or a compute whose inputs are `withheld`.

## P4-05 Medium: ordering operators coerce arbitrary strings through `Date.parse`, giving silent wrong answers

**Where:** `packages/app/src/expr.ts:42-57` (`order`), checker `packages/compiler/src/expr.ts:327-331`.

**What is wrong:** `lt/lte/gt/gte` on two strings call `Date.parse` on both and compare instants. The checker allows ordering of two plain (non-date) strings when their type is not an enum (e.g. two `$input` fields typed `{ type: "string" }`), and at runtime `Date.parse` succeeds on things that are not dates (`"12"` → 2001-12-01, `"Bravo 7"` → 2001-07-01), so a comparison of two ordinary strings returns a confident `true`/`false` that means nothing, and `"5" < "10"` is `true` only because both parse as years. A guard built on such a comparison acts on a meaningless result.

**Repro** (`t8.ts`): `$.lt("2026-10-17T00:00:00Z","12") = false`, `$.gt("2026-10-17T00:00:00Z","Bravo 7") = true` (`Bravo 7` → Sun Jul 01 2001), `$.lt("5","10") = true`. The checker accepts `{ lt: ["$input.since","$input.label"] }` where both are `string` (no date format).

**Fix:** only order strings the checker proved are `format: date`/`date-time` (the checker already guards enum/number; require the format at runtime too). In `order`, return `undefined` (unknown) when either string is not a valid ISO date rather than accepting whatever `Date.parse` salvages; validate with a date regex, not bare `Date.parse`.

## P4-06 Medium: a failed upstream read turns a `where`/`sum` KPI into a confident understated number

**Where:** `packages/app/src/expr.ts:60-68` (`inList`), `:166-168` (`where`), `packages/ui/src/components/layout.tsx:95-108` (`Metric`), cold-chain `atRisk`/`doses-at-risk` in `examples/apps/cold-chain/app.json`.

**What is wrong:** `inList(value, undefined)` returns `undefined` (unknown), so `where(lots, item => inList(item.shipmentId, pluck(openExcursions, …)))` with `openExcursions` failed/absent drops every element (a predicate that is unknown is treated as "does not hold"), yielding `[]`. `sum([], "doses")` is `0`. `Metric` only shows loading/withheld/unavailable when *its own pending data* say so; a value computed to `0` from an upstream failure renders as a plain `0` with `data-state="ready"`. So "Doses at risk: 0" is shown as a settled fact when the excursion service is actually down. This is the exact failure `valueAtRisk` (risk.ts) was written to avoid, but the IR `where`+`sum` KPIs next to it do not get that treatment.

**Repro** (`t9.tsx`): `lots` ready, `openExcursions` undefined → `atRisk = []`, `sum(doses) = 0`; `Metric` renders `<div class="ts-metric-value">0</div>` with `data-state="ready"` (even when one pending datum is `status:"error"`, because the Metric's value was precomputed and the derived error path is not wired into the value).

**Fix:** `inList(value, absentList)` is already unknown — good — but `where` should propagate: if the predicate is *unknown* for an element whose exclusion changes the result, the whole `where` over a list derived from a failed read should be unknown. More robustly, a derived value whose inputs include a failed/`error` datum should itself be `undefined`, and `Metric` should treat `combine(pending) === "error"` as error even when `value` is defined (it currently only checks `status === "loading" && value === undefined`).

## P4-07 Medium: `hidden`/`absentText`/`rows.atMost` screen checks pass against a page that never rendered

**Where:** `packages/compiler/src/verify.ts:166-199`.

**What is wrong:** The settle loop treats "`.ts-app` present and no `[data-state=loading]`" as settled. A page whose bundle failed to load, or that threw before the shell mounted, has no `.ts-app` — so the loop simply times out after `SETTLE_MS`, then the negative assertions (`hidden`, `absentText`, `rows.atMost: 0`) all pass because the nodes are absent and the text is absent. ADR-0084 says "a negative expectation needs a positive signal from a settled page, not a timeout", but there is no positive-settled gate: a never-settled page still runs the comparison.

**Repro** (`t4.ts`): serve HTML referencing a missing module (no app ever mounts); run a screen check asserting `hidden: ["maintenance-status"]`, `absentText: ["NMC"]`, `rows: {attention-table:{atMost:0}}`:
```
{"id":"…","ok":true,"observed":{"present":{…:false},"rows":{…:0},"errors":[]}} 10870ms
```
Passes after a 10 s timeout, proving nothing. (`pageerror` only fires for thrown errors, not a failed module fetch, so `errors` is empty.)

**Fix:** require a positive settle signal (quiet seen at least once with `.ts-app` present) before running any negative assertion; if the deadline is hit without ever settling, fail with "the page did not settle". Also capture failed resource loads (`page.on("requestfailed")` / `response` ≥400 for the bundle), not only `pageerror`.

## P4-08 Medium: a flow key that collides with a generated import breaks the build after a clean check/compile

**Where:** `packages/compiler/src/emit/app.ts:106-113` (server imports `path`, `host`, each flow key), `:112`; parser allows any camelCase flow key (`parse.ts:206`).

**What is wrong:** `server.ts` does `import path from "node:path"` and `import { <flowKey> } from "./src/generated/flows/<flowKey>.js"`. A flow keyed `path` (or `host`, `createAppServer`, etc.) produces a duplicate identifier. `check` and `compile` both succeed; only `build` fails, with a `server.ts` error the author cannot fix in `app.json` without renaming. ADR-0080's promise that the checker decides before code exists is not met for this class.

**Repro** (`t1.ts flowkey-path`):
```
compile ok: true []
build: [ "compile-error server.ts:3:8 TS2300: Duplicate identifier 'path'.", … ]
```

**Fix:** reserve the identifiers `server.ts` uses (`path`, `host`, `createAppServer`, `readLlmConfig`, `createApp`, `root`, `here`, …) as forbidden flow keys in the checker, or alias the flow-key imports (`import { <key> as flow_<key> }`).

## P4-09 Medium: a page-level datum named `local`/`state`/`setState` emits a self-referential declaration that will not compile

**Where:** `packages/compiler/src/emit/pages.ts:12-15` (`dataVar`/`RESERVED`), `:406` (`const local = …`), `:412` (`const [state, setState] = …`).

**What is wrong:** `dataVar` renames a datum named `state`/`row`/etc. to `<name>Data`, but the `RESERVED` set omits `local` and `setState`, and the renaming applies to the data variable but the page also declares `const local = …` and `const [state, setState] = usePageState(local)`. A datum named `local` emits `const local = useRead(…)` and `const local: Record<…> = {…}`, a redeclaration/use-before-init. (The `state` case is caught by `dataVar`, but `local` is not in the set.)

**Repro** (`t1.ts data-local`): page data `{ local: { object read } }` →
```
build: [ "…Board.tsx:21:10 TS7022: 'state' implicitly has type 'any' …", "…'local' used before its declaration", "…'local' is used before being assigned", … ]
```
Compile passes; build fails in generated code.

**Fix:** add `local` (and anything else the page template binds) to `emit/pages.ts` `RESERVED`, and reserve the same names in the parser's data-name check so the error is a checker diagnostic, not a tsc error.

## P4-10 Medium: a page named after a UI component it imports breaks the build

**Where:** `packages/compiler/src/emit/pages.ts:389-395` (imports from `@typesys/ui`), page component name `:411`.

**What is wrong:** A page whose PascalCase name equals an imported UI symbol (`Table`, `Metric`, `Form`, `Chart`, `Grid`, `Detail`, `Map`…) emits `export function Table(...)` alongside `import { Table } from "@typesys/ui"`, a name conflict. `check`/`compile` pass; `build` fails.

**Repro** (`t1.ts page-table`): rename the page to `Table` →
```
build: [ "…Table.tsx:3:55 TS2440: Import declaration conflicts with local declaration of 'Table'.", … ]
```

**Fix:** reserve UI component names as forbidden page names in the checker, or import UI symbols under an alias namespace so a page name can never collide.

## P4-11 Medium: `app.title` is interpolated unescaped into a `server.ts` template literal

**Where:** `packages/compiler/src/emit/app.ts:136`.

**What is wrong:** The non-ready log line embeds the title inside a backtick template with only `` ` `` and `$` stripped — but a backslash is not. A title ending in `\` (e.g. a Windows-ish path, or `…\u`) produces an invalid escape in the generated template literal. `compile` passes, `build` fails on `server.ts`.

**Repro** (`t1.ts title-backslash`): title `Squadron C:\\users\\ops` →
```
compile ok: true []
build: [ 'compile-error server.ts:35:140 TS1125: Hexadecimal digit expected.' ]
```

**Fix:** emit the title with `JSON.stringify` (it is already a plain string) instead of hand-escaping into a template literal; or strip/escape backslashes too.

## P4-12 Medium: `diff` does not treat an AI model/`llm` change as reaching the flow that uses it

**Where:** `packages/compiler/src/diff.ts:139-146` (models compared standalone), `:238-247` (`reached`), `:258` (impact checks).

**What is wrong:** Changing a `models.<role>.id` (pointing an AI step at a different model, possibly a less-cleared audience) is reported as a model change, but nothing links it to the flow that step belongs to, so no `starts`/`approves` check for that flow is listed in "checks to run first". The same for changing `llm`. ADR-0085 says the impact names "the acceptance checks that exercise a changed … flow". A model swap is exactly the change that can alter what a model is released and so what a run produces, yet it surfaces zero checks.

**Repro** (`t10.ts`): `models.triage.id` changed → `checks: []`; `llm` changed → `checks: []`.

**Fix:** when a `models` role or `llm` changes, add every flow with an AI step naming that role to `changedFlows`, so its `starts`/`approves`/screen checks are reached.

## P4-13 Medium: unknown keys in acceptance checks are accepted, so a mistyped assertion silently checks nothing

**Where:** `packages/compiler/src/parse.ts:97-118` (acceptance validation runs no `known()` over check keys), checker `packages/compiler/src/check.ts:1028-1070`.

**What is wrong:** The parser validates `id`/`kind`/`as` and, for `screen`, that at least one of a fixed key set is present — but never rejects *unknown* keys. A check written with `witheld` (typo), `absenttext`, `hiden`, etc. passes validation; the real assertion is simply absent, so the check "passes" having verified nothing. Everywhere else in the IR an unknown key is an `invalid-app` error with a suggestion; acceptance checks are the one place it is not, and they are the definition of done.

**Repro** (`t12.ts`): a `reads` check with `witheld:["maintenanceStatus"]` and a `screen` check with `absenttext`/`hiden` → `diagnostics: []`. The misspelled `witheld`/`absenttext`/`hiden` assertions are ignored and the checks pass on any screen.

**Fix:** run `known()` over each check's keys against the allowed set for its `kind`, mirroring node/step validation.

## P4-14 Medium: a `parallel` inner read's `retry` is silently dropped in lowering and generation

**Where:** `packages/compiler/src/skeleton.ts:66-73` (parallel → one engine read, inner `retry` not carried), `packages/compiler/src/emit/flows.ts:87-95` (inner reads emitted as `() => call`, no retry).

**What is wrong:** A `read` step inside `parallel` accepts `retry` (the parser validates it at `parse.ts:238` for every step including inner ones), but neither the skeleton nor the generated code carries it: the parallel step becomes one engine step with the outer step's retry only, and each inner read is a bare thunk. An author who writes `retry` on a flaky parallel read gets no retry and no diagnostic.

**Repro** (`t11.ts`): inner read `evidence.steps[0].retry = {maxAttempts:5,backoffMs:100}` → `compile ok: true`, `generated mentions retry: false`.

**Fix:** either honour per-inner-read retry (wrap the thunk with a retrying helper) or make the checker reject `retry`/`timeoutMs` on a read inside `parallel` as unsupported, so the author is told.

## P4-15 Medium: `onError:"continue"` output feeding a required input is not caught by `maybe-skipped`

**Where:** `packages/compiler/src/check.ts:508-513` (read step sets `skippedBy:[name]` and then `conditions.set(s.name, undefined)` at :512), `:491-496` (`requireKnown` / `covers`).

**What is wrong:** A `read` with `onError:"continue"` is typed `skippedBy:[name]` (its output may be unknown when the source fails) — but line 512 immediately sets its condition to `undefined`, which makes `implies(when, undefined)` always true (`check.ts:1089`), so `covers` reports the skip as covered. The result: a required action/flow input taken from an `onError:"continue"` read is NOT flagged `maybe-skipped`, even though that output genuinely can be unknown at runtime (the `need(...)` wrapper then fails the step). The parallel `when`-guarded case *is* caught; the `onError` case is not.

**Repro** (`t18.ts`): `onError:"continue"` on the `aircraft` read, its output fed to a required action input → `onError-continue: []` (no diagnostic). The `when`-guarded control correctly reports `maybe-skipped`.

**Fix:** keep a read's `skippedBy` meaningful for the coverage check. The intent (a `when`-covered skip is fine, an `onError` skip has no condition to cover it) is backwards: an `onError:"continue"` output has *no* guard an author can supply, so it should always count as possibly-unknown for a required consumer. Do not set its condition to `undefined` in a way that `covers` reads as "always covered"; treat it as never-covered.

## P4-16 Medium: `page.params` typed non-string are checked as that type but arrive as strings at runtime

**Where:** `packages/compiler/src/check.ts:429-430` (`paramTy` from `schema`), `packages/ui/src/router.tsx:44-50` (params are `decodeURIComponent` strings).

**What is wrong:** A page param declared `{ schema: { type: "integer" } }` is typed as a number by the checker, so `{ gt: ["$params.n", 3] }` type-checks. But router params are always strings. At runtime `$.gt("10", 3)` is `undefined` (string vs number → not comparable), so the guard silently never holds. The checker's model of params disagrees with the runtime's.

**Repro** (`t15.ts`): page `/top/:n` with `n: { schema: { type: "integer" } }` and `when: { gt: ["$params.n", 3] }` → checker error-free; at runtime `$.gt("10", 3) = undefined` so the node is always hidden.

**Fix:** type every page param as `string` in the checker regardless of its declared schema (params are always strings), or coerce params to their declared type in the router before they enter scope. Reject a param schema that is not string-shaped, or document that params are strings and forbid numeric comparisons on them.

## P4-17 Medium: table pagination makes a `rows atMost/atLeast` screen check count only the current page

**Where:** `packages/ui/src/components/table.tsx:98,107` (`getPaginationRowModel`, default `pageSize:25`), `packages/compiler/src/verify.ts:181` (counts `[data-row]` in the DOM).

**What is wrong:** The screen check counts `[data-row]` elements, but the table only renders the current page (default 25 rows). A table with 40 governed rows shows 25 `data-row`s. A `rows: { t: { atLeast: 30 } }` check fails though the caller legitimately received 40; a `rows: { t: { atMost: 25 } }` check passes though 40 were returned. The count reflects the page size, not what the runtime released — which is what ADR-0084 says the check decides ("how many object rows a node shows").

**Repro** (`t22.tsx`): 40 rows into `Table` → `[data-row] in the DOM: 25`.

**Fix:** either count rows from the data node's reported total (expose a `data-rows` count attribute set from `data.value.length`), or disable pagination when a screen check runs, or document that `rows` counts the first page and have the checker reject `atLeast`/`atMost` larger than the table's `pageSize`.

## P4-18 Low: `fillPath`/`navigate` silently produce `/page/` for an unknown or unfilled param

**Where:** `packages/ui/src/router.tsx:56-66` (`fillPath` encodes `toText(params[...]) ?? ""`).

**What is wrong:** Navigating to a parametered page with a missing param yields an empty segment (`/shipments/`), which matches no route and lands on "Not found" with no indication the param was absent. The compiler requires `navigate` params (`check.ts` effects), so the generated path is safe, but any hand-written override or an `into`-less flow can produce a dead link quietly.

**Repro:** `fillPath("/shipments/:id", {})` → `/shipments/`. (Code reading; not a defect in generated output, so Low.)

**Fix:** drop/skip navigation when a required param is unknown, or surface a notice rather than routing to a broken path.

## P4-19 Low: `coalesce` is typed known-as-soon-as-last-value but the runtime can still be unknown

**Where:** `packages/compiler/src/expr.ts:191-204` (coalesce carrying from the last arg only), `packages/app/src/expr.ts:99-103`.

**What is wrong:** The checker returns `coalesce` as carrying only the last value's unknown-ness (`carrying(ty, args[args.length-1])`), modelling "known as soon as its last value is". But at runtime `coalesce` returns `undefined` when *every* argument is absent, and the last argument itself can be withheld — so a `coalesce` whose last arg is a withheld field is typed as possibly-OK in some paths while still able to be unknown. In practice it is used as a default so the risk is small, but the type does not match `need()` behaviour for a required consumer whose only default is itself withheld.

**Repro:** code reading; `coalesce` of two withheld values returns `undefined` at runtime, yet carrying semantics only propagate the last arg's flags. Low because the common pattern (last arg a literal) is sound.

**Fix:** carry unknown-ness as true only if the last argument cannot be unknown (a literal); otherwise mark the result possibly-unknown.

## P4-20 Low: `migrate` copies a view `limit` of 0 as `limit: 0`, which the parser rejects — but larger issue: no page-split or path for many views

**Where:** `packages/compiler/src/migrate.ts:123` (`limit: Number(v.limit ?? 50)`), parser `parse.ts:186` (`limit` must be 1–1000).

**What is wrong:** `Number(v.limit ?? 50)` passes a mission `limit` straight through. A mission `limit: 0` (or a non-integer) becomes `limit: 0`, which the application checker then rejects with `invalid-app` — the migration produces an `app.json` that does not check, contrary to ADR-0086's "migrates, compiles …". It is a narrow input, hence Low, but migrate should not emit a spec it knows the checker refuses.

**Repro:** code reading (mission `limit:0` → `app.json` `query.limit:0` → `invalid-app /pages/0/data/<v>/query/limit`).

**Fix:** clamp/validate the translated limit to 1–1000, or omit it when out of range, and add a `mission-translation` note.

## P4-21 Low: `where`/`sum` over a list with some withheld elements silently excludes them (documented, but KPI risk)

**Where:** `packages/app/src/expr.ts:135-168`, checker `expr.ts:155-156`.

**What is wrong:** `sum`/`avg`/`min`/`max` over a field return `undefined` if *any* element lacks the field (good — understatement avoided). But `where` drops elements whose predicate is unknown, so a `count(where(list, pred))` understates when the predicate depends on a withheld field, without going unknown. The checker marks `sum` of an optional field `withheld` but does not propagate the same caution to `count(where(...))`. This is the same family as P4-06 but for `count`.

**Repro:** `t9.tsx` shows `count(atRisk) = 0` when `openExcursions` is absent; a predicate over a withheld field would likewise undercount with a confident integer.

**Fix:** make `where` yield unknown (so `count` is unknown) when its predicate is unknown for any element and the list came from a withheld/failed source; or document and surface a "partial" marker on counts derived this way.

## P4-22 Low: `concat` in an Action input coerces numbers to strings implicitly, hiding locale/format

**Where:** `packages/app/src/expr.ts:124-128`, used in generated disposition `reason` (`examples/apps/cold-chain/src/generated/flows/disposition.ts`).

**What is wrong:** `concat` stringifies numbers with `String(x)`, not the display formatter, so a number embedded in a reason/audit string is the raw JS number. Harmless for ids, but a temperature or cost concatenated into a reason is unformatted and locale-blind. Low; noted because reasons become audit records.

**Fix:** acceptable as-is for machine strings; if human-facing, format explicitly.

## P4-23 Low: `self-approval` is only a warning; `allowSelfApproval` with the same start and approval policy passes check

**Where:** `packages/compiler/src/check.ts:654-655` (warn), cold-chain uses `coldchain.qa-release` distinct from `coldchain.dispose` (good).

**What is wrong:** `allowSelfApproval: true` is a warning only. A flow whose start policy and approval policy admit the same caller, with self-approval on, lets the initiator approve their own run with no error — the governance intent (separation of duty) is advisory. The cold-chain app does the right thing (distinct `qa-release`), but nothing stops the opposite.

**Fix:** keep as warning if deliberate, but consider an error when the approval policy and start policy admit an identical caller set and `allowSelfApproval` is set.

## P4-24 Low (inferred): `findChromium` trusts `CHROME_PATH` without verifying it is Chromium

**Where:** `packages/compiler/src/verify.ts:113-123`.

**What is wrong:** `findChromium` returns `process.env.CHROME_PATH` if the file exists, launched with `--no-sandbox`. If an environment sets `CHROME_PATH` to an arbitrary executable, `verify` runs it. This is an environment-trust issue rather than an app.json path, so Low and inferred (not reproduced — would require pointing it at a non-browser). Noted because screen-check verdicts depend on it and `--no-sandbox` widens the blast radius.

**Fix:** none strictly required (operator-controlled env), but documenting that `CHROME_PATH` must be a Chromium build, and not passing `--no-sandbox` unconditionally, would reduce risk.

## P4-25 Low: `spa` fallback serves `index.html` for any non-`/api` HTML GET including unknown deep links

**Where:** `packages/http/src/client.ts:58-63`.

**What is wrong:** `clientRouter({spa:true})` answers every extension-less HTML GET outside `/api` with `index.html`. That is the intended deep-link behaviour, but it means an unknown path returns 200 + the app shell (which then renders its own "Not found"), rather than a 404. Fine for an SPA, but a monitoring probe or a link checker sees 200 for nonexistent routes. Low.

**Fix:** acceptable; if 404 semantics matter, let the client signal not-found via status on known-bad routes.

## P4-26 Low: `rows` helper caps `all` at 10k silently; a larger governed result is truncated without signal

**Where:** `packages/app/src/read.ts:288-311` (`ALL_ROWS_CAP = 10_000`, `.slice(0, max)`).

**What is wrong:** `rows(query, {all:true})` with no limit stops at 10,000 and slices, returning a truncated list with no indication it was cut. A KPI or a `forEach` source built on it would silently be computed over the first 10k. The cursor-repeat guard is good; the silent cap is the issue. Low because 10k is generous and the default UI reads one page.

**Fix:** when the cap is hit and a next cursor still exists, surface it (throw like the adapter's "narrow the query", or flag the result partial) rather than slicing silently.

---

### Notes on things that are correct (so they are not re-investigated)
- HTTP adapter `aggregate` over multi-page services honours row-level filters as the carrier (reproduced, `t16.ts`).
- AI model release re-reads reads/aggregates as the audience and refuses when the view differs (`t20.ts`: default `release:"refuse"` fails closed with `ReleaseRefusedError`).
- `maybe-skipped` correctly fires for `when`-guarded steps feeding required inputs (`t5.ts`, `t14.ts`), and `if`-on-unknown in an action input is handled soundly at runtime (`t14.ts`).
- Setting a nullable state to `null` is a type error only because the enum form (`["string","null"]`) is modelled as nullable-string, not null — the error at `t13.ts` is a genuine false positive worth noting but low-value; folded into P4-16's family of param/state typing gaps if pursued.

## Disposition (2026-10-17)

Twenty-one findings are fixed, one of them in part. Four are kept as they
are, for the reasons given below, and one did not reproduce. Each fix has a test that failed
before it. The tests are in
[`packages/compiler/test/pressure.test.ts`](../../packages/compiler/test/pressure.test.ts),
[`packages/ui/test/pressure.test.ts`](../../packages/ui/test/pressure.test.ts),
[`packages/cold-chain/test/approval-aggregate.test.ts`](../../packages/cold-chain/test/approval-aggregate.test.ts)
and `packages/app/test/expr.test.ts`.

Ten new mutations in
[`tools/mutation/catalog.json`](../../tools/mutation/catalog.json) guard
the fixes most likely to regress. They are `compiler.design-system-unchecked`,
`compiler.lock-outside-root`, `compiler.lockless-overwrite`,
`compiler.order-one-side-dated`, `compiler.check-keys-unchecked`,
`compiler.on-error-covered`, `app.where-drops-unknown`,
`app.order-parses-anything`, `workflow.approver-sees-aggregate` and
`ui.derived-from-nothing`. All ten were killed in a targeted run.

| Finding | Disposition |
|---|---|
| P4-01 | **Fixed.** The parser accepts `design.system` only as `meridian`, `ledger` or `<module>#<Export>`, the same shape a custom component has. It also accepts only known `design` keys, and `tokens`, `density`, `brand` and `signIn` are typed. Nothing else reaches the emitted import or identifier. |
| P4-02 | **Fixed.** A lock entry that is absolute, not normalised, or that leaves the application is an `invalid-lock` error. Such an entry is never read or removed. A lock whose `files` is not a map of hashes counts as no lock. |
| P4-03 | **Fixed.** A file the compiler would own but the lock does not record is overwritten only when it already says what the compiler writes. This covers both a missing lock and a page added beside an existing file. Otherwise compiling stops with `edited-generated-file` unless `--force` is given. |
| P4-04 | **Fixed in the workflow engine.** In an approver's view, a read whose output is not made only of objects (an aggregate's totals, a count) is read again as the approver. The approver is shown it only when that read gives the same value, and otherwise is shown nothing. Objects are still redacted field by field, and a parallel step's named record of reads counts as objects. |
| P4-05 | **Fixed.** An ordering needs both sides to be dates: a `date` or `date-time` field, or a literal written as one. At run time, two strings are ordered only when both are RFC 3339 dates, never by whatever `Date.parse` salvages. |
| P4-06, P4-21 | **Fixed.** `where` is unknown when its predicate is unknown for any element, and the checker carries the predicate's unknown-ness into the result. `useDerived` gives no value while an input has none (loading, failed or waiting). A figure over a failed read now shows as unavailable instead of `0`. |
| P4-07 | **Fixed.** A screen check fails when its page never settles. It also reports a page asset (document, script or stylesheet) from the application's own origin that failed to load or answered 400 or above. |
| P4-08 | **Fixed.** `server.ts` imports each flow as `flow_<key>`, so no flow key can collide with the server's own names. |
| P4-09 | **Fixed.** `local`, `useRead` and the camelCase helpers a page imports are reserved, so a datum with one of those names is renamed. |
| P4-10 | **Fixed.** A page named like a component it draws is declared as `<Name>Page` and exported under its own name. |
| P4-11 | **Fixed.** The ready line prints the title through `JSON.stringify` instead of hand-escaping it. |
| P4-12 | **Fixed.** A changed, added or removed model role reaches every flow with an AI step asking it, and so do that flow's checks and pages. A changed `llm` reaches every flow with an AI step. |
| P4-13 | **Fixed.** Each kind of check accepts only its own fields, and so does each `rows` entry. A misspelt assertion is an error with a suggested correction. |
| P4-14 | **Fixed.** A retry on a read inside `parallel` becomes the parallel step's retry when that step has none. It takes the most attempts and the longest backoff any of its reads asks for. Reads change nothing, so repeating all of them is safe. |
| P4-15 | **Fixed.** A read with `onError: "continue"` has no condition a consumer could share, so a required input taken from it is always `maybe-skipped`. |
| P4-16 | **Fixed.** A page param is declared as a string. It comes from the path, and any other type is a `page-param` error. |
| P4-17 | **Fixed.** A table reports how many rows it was given as `data-rows`, and a screen check counts that number, not the page of rows it draws. |
| P4-18 | **Fixed.** `fillPath` gives no path when a parameter is unknown or empty. `navigate` then does nothing, and `PageLink` renders plain text. |
| P4-19 | **Kept.** `coalesce` is unknown only when its last value can be, and the checker carries exactly that value's unknown-ness. A last value that may be withheld therefore marks the result withheld, so the type matches the run. |
| P4-20 | **Does not reproduce.** A mission whose view limit is outside 1 to 1000 is refused by the mission validator (`invalid-mission /views/0/limit`) before translation, so `migrate` never produces that query. The test records this. |
| P4-22 | **Kept.** `concat` writes machine strings, such as audit reasons and identifiers. A person-facing figure is formatted by the node that shows it. |
| P4-23 | **Kept as a warning.** `allowSelfApproval` is an explicit opt-in that a requirement may call for, and the checker warns wherever it is set. |
| P4-24 | **Fixed in part.** `verify` passes `--no-sandbox` only when it runs as root, where Chromium's sandbox cannot start. `CHROME_PATH` remains the operator's to set. |
| P4-25 | **Kept.** The client answers an unknown deep link with the application shell, which shows "Not found". That is how a single-page application's history routing works. |
| P4-26 | **Fixed.** `rows` with `all` and no limit refuses a result larger than 10,000 rows instead of cutting it, and says to narrow the query or give it a limit. A limit the read names is honoured. |
