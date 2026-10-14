# @typesys/studio

TypeS Studio ([ADR-0061](../../docs/adr/0061-typesys-studio.md)): a
browser workbench over the governed API. Explore the model, compose a
query with live validation, see its execution plan and the typed SDK code
that builds it, and preview Actions before invoking them, always as the
person signed in. The Studio has no authority of its own: every value,
refusal and preview it shows is the runtime's answer for that person's
token.

```ts
import { createStudioApp } from "@typesys/studio";

const app = createStudioApp({ backend: { registry, runtime }, identityResolver });
app.listen(8080, "127.0.0.1");   // the Studio at /, the API at /api
```

`createStudioApp` takes everything `createApiApp` (`@typesys/http`) does,
plus `title` and, for a demonstration only, `demoTokens`, which the page
offers as one-click sign-ins to anyone who can open it.

From the repository: `npm run build && npm run studio`, then open
http://localhost:4400 and switch between the maintainer, the viewer and
anonymous access.

See [`docs/how-to/explore-with-the-studio.md`](../../docs/how-to/explore-with-the-studio.md).
