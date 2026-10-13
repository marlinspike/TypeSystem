# 0061. TypeS Studio: A Browser Workbench With No Authority of Its Own

## Status

Accepted. Implemented in:

- the new `@typesys/studio`: `createStudioApp`, which serves the governed API (ADR-0058) under `/api` beside a bundled browser client, and `STUDIO_CLIENT_DIR`;
- `@typesys/sdk`, which gains `querySource` (a query as the fluent SDK code that builds it) and `httpCall` (one authenticated call to the API, now shared by `httpTransport`);
- `@typesys/http`, which gains `GET /me`: the caller the API resolved from the token;
- `scripts/build-studio.ts` (since ADR-0063 `scripts/build-clients.ts`, which bundles every browser client), run by `npm run build`, and `npm run studio`, which serves the Studio over the airforce demo.

Proven by:

- `packages/studio/test/studio.test.ts`:
  - The page and its assets are served under a Content Security Policy that allows only the page's own script, style and API calls, with no inline script, no framing, no `<base>` and no form posts, plus `nosniff`, `no-referrer` and a same-origin opener policy.
  - Demo sign-ins are offered only when the server is given them.
  - A server whose client is not built says so (503) instead of serving an empty page.
  - The API beside the page answers each caller as the runtime does: the viewer's rows never carry the SECRET `deploymentLocation`, the maintainer's do, and an anonymous query is refused.
  - A call carrying another site's `Origin` is refused.
  - Applying a diagnostic's suggestion writes it exactly where the diagnostic's JSON Pointer points, escaped tokens included, and leaves the text alone when the pointer no longer reaches a string.
  - Each step of a real execution plan, fetched as the viewer, becomes one numbered sentence, and every note is kept.
- `packages/studio/test/browser.test.ts`, in Chromium through the built bundle:
  - A misspelt value is flagged by the API's validator, Run is disabled, and one click applies the suggestion. The SDK code panel then shows exactly the code that builds the corrected query.
  - The same query run as the viewer shows every `deploymentLocation` cell empty; run as the maintainer, it shows them.
  - The viewer's Action preview is refused on authorization and offers no Invoke.
  - The maintainer's preview would run. Editing the form afterwards withdraws Invoke until the input is previewed again. Confirming invokes exactly the previewed input.
  - The page logs no script error and no blocked resource throughout.

  It skips without a Chromium or before the client is built. GitHub's runners have Chrome, and CI builds before it tests.
- `packages/sdk/test/source.test.ts`: 2,000 generated queries each become code that, run against the SDK, builds the same query.

Mutation-checked: 21 mutations, each failing at least one test.

- Server: inline script allowed; framing allowed; no security headers; demo sign-ins always offered; an unbuilt client served silently.
- Screen logic: a suggestion overwriting a non-string; pointer tokens not unescaped; plan notes dropped; `null` shown as a value; selected columns not first.
- Client, in the browser: Invoke after the form changed; Invoke on a refused preview; Run despite validation errors; the token not sent; invoking other input than was previewed.
- `querySource`: `or` written as `and`; non-identifier names unbracketed; sort direction dropped; search properties dropped; provenance dropped; an empty `and` accepted.

Two further `querySource` mutants are equivalent and were not counted. Naming every nested include's parameter `q` only shadows a name. Dropping an include's `limit` of 0 only affects a query the runtime refuses anyway, since its minimum is 1.

## Context

Slices 4 to 8 gave developers and agents a typed SDK, validation with suggestions, execution plans, Action previews, an HTTP API and generated forms and columns. Each was reachable only from code. The people who decide what a mission application should do (an analyst, a product owner, an accreditor) had no way to see the model, try a query, or watch the same screen answer two people differently. A developer had no fast loop from "what am I allowed to ask?" to code.

A workbench like this usually becomes a second, privileged path: an admin console with a service account, its own queries and its own idea of who may see what. That is exactly what TypeS exists to prevent.

## Decision

**The Studio is a client of the public API and nothing else.** `createStudioApp` is `createApiApp` (ADR-0058) plus three things:

- `/studio/config.json`, which holds a title and, only when the server is given them, demo sign-ins;
- the static client;
- security headers on both.

The client signs in with a bearer token and sends it on every call, through the SDK's `httpTransport` and the new `httpCall`. It has no route, credential or decision of its own. Every value, refusal, plan and preview it shows is the runtime's answer to that person. Switching the token is how the Studio shows what someone else may see; it cannot show more than the person signed in.

**Three screens, each built on a capability that already existed:**

- **Model.** The model description (ADR-0056) with `columnsFor` (ADR-0058), relationships, Actions, and discovery by task. The description is the contract, the same for every caller, so it shows no policy names; who sees a value is shown by running a query.
- **Query.**
  - The JSON query (ADR-0011) is checked by `POST /query/validate` as it is typed. A diagnostic's suggestion is applied by its JSON Pointer.
  - Run is disabled while the validator reports an error.
  - Explain shows the execution plan for this caller (ADR-0054) as sentences.
  - Run shows results with paging. An empty cell is stated to mean "withheld or not set", never guessed at.
  - `querySource` shows the typed SDK code (ADR-0055) that builds the same query, so a query tried in the Studio is pasted into an application unchanged.
- **Actions.** A form from `formFields` and `coerceForm` (ADR-0058). Preview (ADR-0053) comes first. Invoke appears only when the preview says the Action would run and the form still holds the previewed input, and it sends that input after a confirmation that names the side effects.

**Security by construction in the browser too:**

- The token lives in `sessionStorage`, so it is scoped to the tab and gone when the tab closes.
- The Content Security Policy allows script only from the page's own origin and no inline script, so injected markup cannot run code that reads the token. React escapes every value the API returns.
- The page cannot be framed (clickjacking) and sends no referrer.
- The API's own Host and Origin checks (ADR-0058) still apply, so another site's page cannot drive it with a visitor's browser.

**Built with the repository's tools, bundled once.** The client is TSX type-checked and linted with the rest of the code in a project of its own that adds DOM and JSX. `esbuild` bundles it in about 0.6 s into one script (about 53 KB gzipped), one stylesheet and the page. React, the SDK and `@typesys/react` are bundled; core, Node-only, is not, and the client takes only its types. There is no development server or framework.

## Consequences

- A person can see, without writing code, exactly what the runtime gives them and what it would give someone else, and leave with code that does the same.
- The Studio adds nothing to accredit beyond a static client: its server is the API, plus a configuration document and static files.
- Every Studio call is an ordinary API call by the signed-in person, so it is authorized and audited as one, and rate-limited when the runtime is given a limiter (ADR-0019). Measured over loopback, p50: validate 1.6 ms, explain 1.4 ms, query 1.2 ms, model 1.1 ms ([evidence](../evidence/studio-2026-10-13.md)).
- Demo sign-ins are visible to anyone who can open the page, so they are opt-in, and the demo script is the only caller that passes them.
- Not done:
  - no sign-in flow: a deployment pastes a token, or puts the Studio behind a proxy that adds one;
  - no workflow screens (start, approve, replay) and no aggregate builder;
  - no provenance view of a value;
  - no editing of the model: the Studio reads the model, and authoring stays in code, YAML and packs;
  - the query editor is a text area, with no completion;
  - the browser test covers Chromium only.

## Alternatives Considered

- **An admin console with its own service identity.** Faster to build and able to show everything, but it is the second path TypeS exists to remove: a console that can see more than its user becomes the easiest way around policy.
- **Extending the demo console (`demo-web`).** It is a demonstration with its own routes and inline scripts (ADR-0058 kept it as is). Building on it would carry those into a tool meant for real use.
- **A full framework (Next.js, Vite).** A development server, routing and server rendering are more than three screens over one API need, and each adds dependencies and a build to accredit. One bundling step with `esbuild`, already a dependency of `tsx`, does the job.
- **Generating the SDK code on the server.** It would cost an API call per keystroke for something the client can do with the SDK it already bundles.
