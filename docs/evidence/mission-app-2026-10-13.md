# A mission application, composed and by hand, 2026-10-13

Slice 10b of the [roadmap](../roadmap.md),
[ADR-0063](../adr/0063-a-mission-application-composed-and-by-hand.md).
The question is the one the baseline
([`baseline-2026-10-13.md`](baseline-2026-10-13.md)) left open: does
building on the composition platform make an application faster to write
and harder to get wrong, without making it less safe?

## Method

**The application.** A squadron readiness board over 24 aircraft
(`missionFleet()`, deterministic). It covers four tasks:

- the aircraft that need attention, and each one's maintenance history;
- opening a work order for an event, and updating a work order's status;
- grounding an aircraft for repair, where a model triages its history and a lead other than the requester approves;
- the work order that grounding then opens and starts.

**Two versions over one system.** Both run on `buildMissionBackend()`:
the airforce domain and its policies, with reads coalesced (ADR-0062), and
the ground-for-repair workflow. They have the same screens and the same test ids, and
share only the page frame and sign-in (`src/shared/client/shell.tsx`),
which is counted in neither.

- *Composed* (`src/composed/`): `createApiApp` and `clientRouter` on the
  server; the typed SDK, the React hooks, `listActions`, Action previews
  and `httpWorkflows` in the client.
- *By hand* (`src/handwritten/`): what the baseline offered. The runtime
  in process with string names and `unknown` values, the app's own routes
  and wire types, the board filtered after reading every aircraft, and
  the grounding process written out. The access rules the interface needs
  before a click are restated and marked `// ACCESS:`.

**One scenario** (`test/scenario.ts`). Chromium signs in as a viewer, a
maintainer and a lead, and records what each sees. The test expects the
same record from both versions. Both pass.

**The comparison** (`npx tsx scripts/compare-mission-apps.ts`, after
`npm run build`) measures five things:

- **Lines of code.** Lines that are neither blank nor comments, per layer.
- **Seeded mistakes.** Each mistake is applied to one version's source. It counts as caught by the compiler when the version no longer typechecks (`tools/eslint/tsconfig.mission.json`). Otherwise the clients are rebuilt and the scenario runs in a fresh process. It is caught by the scenario if what the scenario sees differs, and silent if not.
- **Policy drift.** The scenario runs with one rule changed and neither version edited: `airforce.work-order-assignee` becomes "any maintainer".
- **Latency.** The board as each client asks for it, over HTTP on loopback, as the maintainer. 5 warm-up calls, then 40 timed.
- **Environment.** Node 22, one process per server, Chromium 141 (Playwright's build).

## Results

| | Composed from TypeS | Written by hand |
|---|---|---|
| Server, lines of code | 8 | 148 |
| Client, lines of code | 185 | 207 |
| Total | 193 | 355 |
| Access rules restated in the app | 0 | 7 |
| Wire types kept in step by hand | 0 | 4 |
| Follows a policy change with no edit | yes | no |

| Seeded mistake | Composed | Hand-written |
|---|---|---|
| Misspell a property the board shows | compile | scenario |
| Misspell the type the board reads | compile | scenario |
| Read a field under the wrong name | compile | scenario |
| Misspell an Action's input field | compile | scenario |
| Offer a work-order status the model does not have | compile (scenario as first written) | scenario |
| Offer opening a work order without asking whether the person may | scenario | scenario |
| Restate who may update a work order, leaving out the maintainer role | n/a | silent |
| Let the person who asked approve their own proposal | n/a | silent |
| Trust the triage model's answer without checking it names this aircraft's event | n/a | silent |

`n/a` means the composed version holds no copy of the rule. The rule sits
in the domain's policy or workflow, shared by every application and
agent.

| Maintenance latency per call | Composed board p50 / p95 ms, two runs | Hand-written board p50 / p95 ms, two runs |
|---|---|---|
| 0 ms | 8.8 / 12.8, 8.4 / 10.3 | 9.0 / 15.7, 7.3 / 12.4 |
| 2 ms | 9.8 / 19.6, 10.1 / 13.8 | 10.1 / 15.1, 10.2 / 16.2 |

## What this shows, and what it does not

- **Code.** The composed version is 54% of the hand-written one. Almost
  all of the difference is the server: routes, error mapping, value
  shaping, the grounding process and its pending store. The clients are
  within 11% of each other, because they draw the same screens.
- **Mistakes the compiler now catches.** Five of the six mistakes both
  versions can make are compile errors in the composed version, and run
  time failures in the hand-written one. They are caught here only
  because the scenario happens to look at the affected screen.
- **The status list.** It was first written as an untyped constant, and
  the compiler missed the misspelling; one type annotation from the model
  fixed that. The SDK types what goes through it, but a list an
  application writes beside it is only as typed as its author makes it.
  The how-to now says so.
- **The silent three.** Each is a rule the hand-written version has to
  restate. Two are holes, not interface slips: self-approval, and opening
  a work order for whatever the model names. The runtime refuses neither,
  because they are process rules, and in the hand-written version the
  process is the application's own code. The first, a misstated update
  rule, only offers a control the runtime then refuses. It is the mistake
  actually made while writing the hand-written version.
- **Drift.** When the policy let any maintainer update any work order, the
  composed version offered the control, and the hand-written version went
  on hiding it. It would also go on offering a control after a policy
  tightened, which then fails on click.
- **Time.** No difference worth claiming: p50 7 to 10 ms either way, p95
  noisy. Filtering on a computed property still computes it for every
  aircraft (ADR-0054), as the hand-written filter does. What the query
  form buys is less code and correct paging, not speed.
- **Not equivalent, beyond the scenario.** The hand-written grounding
  process keeps its pending approvals in memory, with no journal, no
  retries, no audit of the approval, no crash recovery, and no replay. The
  scenario does not exercise any of those, so it is not counted above.
  Writing them by hand would widen the gap.
- **Not measured.** How long either version took to write. Both were
  written by the same author, in the same session, with full knowledge of
  the domain. Lines and caught mistakes stand in for effort here; they are
  not a measure of it. The mistakes were chosen by hand and are listed in
  full in the script.
