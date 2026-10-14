# How to explore a model with TypeSys Studio

TypeSys Studio is a browser workbench over the governed API
([ADR-0061](../adr/0061-typesys-studio.md)). It shows the model, checks
and explains queries, writes the typed SDK code for them, and previews
Actions, always as the person signed in. It has no access of its own, so
what it shows one person is exactly what the runtime would return to that
person's application or agent.

## 1. Try it on the demo

```sh
npm install
npm run build      # also bundles the Studio's client
npm run studio     # http://localhost:4400
```

The header offers the demo's Maintainer and Viewer tokens and anonymous
access. Switch between them on any screen to see what each may see and do.

With `TYPESYS_DISCOVERY=need-to-know npm run studio` the Model screen is
narrowed too: the Viewer is not told the SECRET location, the
maintainer-only status or any Action, and anonymous access is told nothing
([ADR-0068](../adr/0068-discovery-is-decided-by-the-runtime.md)). The
runtime's `discovery` option decides this, for the Studio, the HTTP API and
MCP alike.

## 2. Serve it over your own runtime

```ts
import { createStudioApp } from "@typesys/studio";
import { createOidcIdentityResolver } from "@typesys/auth-oidc";

const app = createStudioApp({
  backend: { registry, runtime },                   // what buildRuntime returns
  identityResolver: createOidcIdentityResolver({ issuer, audience }),
  allowedHosts: ["studio.example.mil"],            // as for createApiApp
  title: "Maintenance Studio"
});
app.listen(8080);
```

The Studio is at `/` and the API at `/api`, with every option of
`createApiApp` (`@typesys/http`). People sign in by pasting a bearer
token, which the page keeps for the browser tab only. To sign people in
with your identity provider instead, put the Studio behind a proxy that
adds the `Authorization` header.

Leave out `demoTokens` in any real deployment: they are shown to everyone
who can open the page.

## 3. Find what serves a task

On **Model**, type a task under "Find by task" (for example, "aircraft
that need attention"). Matching Types and Actions are listed. A Type shows
its values as composed from `extends` and traits, which values are
computed and from what, its relationships and the Actions that apply to
it. "Query this Type" starts a query.

## 4. Compose and check a query

On **Query**, edit the JSON query. As you type:

- the validator reports unknown names, operators and values that can
  never match, and filters that match everything. A misspelt name comes
  with a suggestion; select it to apply it. Run stays disabled while
  there is an error;
- the right-hand panel shows the typed SDK code that builds the same
  query, to paste into an application:

  ```ts
  client.from("airforce.Aircraft")
    .where((f) => f.status.eq("active").and(f.needsAttention.eq(true)))
    .select("tailNumber")
  ```

**Explain** shows how the runtime would run the query for you: what it
pushes to the source, where it decides each object, what it computes and
withholds, and what it filters after computing. **Run** shows the results.
An empty cell is a value you may not see, or one that is not set; the
Studio does not tell them apart, because the runtime does not tell you.

## 5. Preview and invoke an Action

On **Actions**, choose an Action and fill in its form. **Preview** asks
the runtime what it would decide for you with this input, with nothing
executed: whether you are authorized, whether the input is valid, and
whether each precondition holds. **Invoke…** appears only when the
preview says the Action would run, and only while the form still holds
the input you previewed. Confirming invokes exactly that input.

## Limits

The Studio does not edit the model, start or approve workflows, build
aggregations, or show a value's provenance. Its query editor has no
completion. See ADR-0061.
