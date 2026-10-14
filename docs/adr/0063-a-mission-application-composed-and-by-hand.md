# 0063. A Mission Application, Composed and by Hand

## Status

Accepted. Implemented in the private `@typesys/mission-readiness` package: a squadron readiness application written twice over one airforce system, once composed from TypeS and once by hand. It adds four small pieces to the published packages, each needed by the composed version and none specific to it:

- `@typesys/http`: `clientRouter`, which serves a bundled client beside the API (the Studio now uses it), and `GET /workflow-approvals`.
- `@typesys/workflow`: `WorkflowEngine.approvalsFor`.
- `@typesys/sdk`: `httpWorkflows`, the workflow routes as a typed client.
- `@typesys/react`: `dataOf` and `errorOf`.

Measured by `scripts/compare-mission-apps.ts`; results in [`evidence/mission-app-2026-10-13.md`](../evidence/mission-app-2026-10-13.md).

Proven by:

- `packages/mission-readiness/test/browser.test.ts`:
  - Chromium drives each version through one scenario (`test/scenario.ts`) as a viewer, a maintainer and a lead.
  - The scenario covers the board, an aircraft's history, opening a work order, starting it, and grounding an aircraft for repair, which a lead approves.
  - Both versions must show exactly the same, and the page must log no error.
  - That includes the viewer seeing which aircraft need attention but not their readiness or location, and controls offered only where the policy allows.
- `packages/mission-readiness/test/apps.test.ts`:
  - Both servers serve their client under `CLIENT_CSP` and refuse another origin.
  - The hand-written server leaves refusals to the runtime.
  - Its approvals are held for a lead other than the person who asked.
  - The composed version lists a waiting run for the lead only.
  - Only the demo's own tokens resolve.
  - A policy override changes a decision.
- `packages/workflow/test/workflow.test.ts`:
  - `approvalsFor` lists only runs waiting on an approval the caller may give, not a run left mid-flight by a crash or a finished one.
  - It reports a failing presentation rather than hiding it.
- `packages/http/test/api.test.ts`:
  - The SDK's workflow client starts, shows, approves and reads a run as each caller.
  - Approvals are listed for the lead, and never for the initiator or a viewer.
  - Its status type equals the engine's, checked at compile time.
- `packages/react/test/react.test.ts`: `dataOf` and `errorOf` over every state.

Mutation-checked: 24 mutations, 22 failing at least one test. The two that survive are equivalent for this domain:

- skipping a run that is not waiting, without also skipping a finished one (a finished run never waits);
- the hand-written ground route's `needsAttention !== true` loosened to `=== false` (a maintainer can always read it, and no one else gets that far).

The caught ones cover:

- the approvals listing: what it skips, and which errors it swallows;
- the client router's headers, configuration path and unbuilt answer;
- the route and SDK path;
- `dataOf` and `errorOf`;
- the backend's overrides and token lookup;
- both clients' permission gates and the composed preview check;
- the hand-written server's approval rules and the started work order;
- the composed server without workflows.

## Context

The roadmap's last slice asks whether everything before it makes an application faster to build without making it less safe. "Faster" could only be argued from the baseline ([`evidence/baseline-2026-10-13.md`](../evidence/baseline-2026-10-13.md)), which recorded the friction of the old way: string names, `unknown` values, no filtering on computed properties, no previews, and no workflow model. An argument is not a measurement. The mandate asked for a mission application in the airforce domain, and for improvements to be measured, not claimed.

## Decision

**Build one application twice, and measure the difference.** The application is a squadron readiness board for 24 aircraft. It shows the aircraft that need attention and each aircraft's maintenance history. It lets a maintainer open and update work orders, and ground an aircraft for repair after a lead approves the triage of its history.

- **The same system underneath.** Both versions run on `buildMissionBackend()`: the airforce domain, its policies, the mock maintenance system with reads coalesced (ADR-0062), and the ground-for-repair workflow (ADR-0057). Neither version can be less safe than the runtime lets it be.
- **The composed version** is `createApiApp` plus `clientRouter` on the server: eight lines. Its client uses the typed SDK and the React hooks. It filters the board on the computed `needsAttention`, offers a control only when `listActions` says the person may use it on that object, previews before invoking, and runs grounding as the workflow. It holds no access rule of its own.
- **The hand-written version** uses what the baseline offered: the runtime in process with string names and `unknown` values, its own routes, error mapping and wire types, the board filtered after reading every aircraft, and the grounding process written out by hand. Where the interface needs to know what a person may do before they try, it restates the domain's rule. Each such line is marked `// ACCESS:`. The runtime still decides every read and Action it makes.
- **One scenario for both.** The browser scenario reads only what a person sees, through the same test ids, so it cannot favor one version's internals. It states the policy as people meet it, and both versions must match it exactly.
- **The measurements**, by `scripts/compare-mission-apps.ts`:
  - lines of code per layer, with the shared page frame counted in neither;
  - access rules restated, and wire types kept in step by hand;
  - where each of nine seeded mistakes is caught: the compiler, the scenario, or nowhere;
  - whether each version follows a policy change with no edit;
  - the board's latency.

  The mistakes are a list chosen by hand and printed in full. They are evidence of what these mistakes show, not a defect rate.

## Consequences

- The composed version is about half the code (193 lines against 355). The difference is almost all server: 8 lines against 148. The clients are close (185 against 207), because the screens are the same.
- The composed version restates no access rule. The hand-written one restates 4 distinct rules, marked at 7 places, and keeps 4 response shapes in step with its server by hand; the composed client still types 1 by hand (the approval's presented values). The composed version's 136-line workflow definition is counted in neither total. (Corrected 2026-10-14 after the [pressure test](../evidence/pressure-test-2026-10-14.md).)
- When a policy changes, the composed version follows it with no edit, and the hand-written one does not. In the experiment, any maintainer was allowed to update any work order. The composed version offered the control; the hand-written one went on hiding it.
- Of the nine seeded mistakes:
  - The compiler caught five in the composed version that the hand-written one caught only in the browser: a misspelt property, type, field read, Action input and work-order status.
  - One was caught in the browser in both versions: offering a control without asking whether the person may use it.
  - Three are mistakes only the hand-written version can make, because only it holds the rule. A misstated update rule, self-approval, and an unchecked model answer all passed every check.
  - Two of those three are real holes, not interface slips: self-approval and acting on an unchecked model answer. The runtime refuses neither, because both are process rules, and the hand-written version owns its process.
- The status misspelling was not caught at compile time in the composed version as first written: its list of statuses was not typed against the model, so only the browser scenario caught it. Typing it (`NonNullable<WorkOrder["status"]>[]`, one annotation) made the compiler catch it. The how-to says so, and the evidence records both results.
- The board answers in about the same time either way (p50 about 7 to 10 ms on this fleet). Filtering on a computed property in the query reads every aircraft, as the hand-written filter does. It saves code and keeps paging correct, not time.
- The `n/a` rows in the mistake list are not free. A misstated rule in the domain's policy or workflow is still possible. It is made once, where every application and agent shares it and the domain's tests cover it, rather than once per application.
- `clientRouter` is now the one way a package serves a browser client. The Studio's own copy of that code is gone.

## Alternatives Considered

- **Count lines between the existing demo console and a new composed app.** Rejected: the demo console does different things. A comparison means the same screens, the same system and the same scenario.
- **Have the hand-written version call the HTTP API instead of the runtime in process.** Rejected: the baseline had no governed HTTP API (ADR-0058 added it). Calling the runtime in process is what an application could do then, and it is the version's most favorable choice, since it skips a network hop.
- **Restate no rules in the hand-written client, and let refusals arrive on click.** Possible, and it would avoid drift. But it would offer every control to everyone, which the scenario rejects: a viewer must not be shown a work-order button. An application that wants to know before a click needs either the rule or `listActions`.
- **Seed mistakes randomly.** Rejected for now: random edits mostly break syntax, which both versions catch alike. The hand-chosen list is printed with its results so a reader can judge the choice.
