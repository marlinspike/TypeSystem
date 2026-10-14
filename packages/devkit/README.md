# @typesys/devkit

Machine-readable tooling over a TypeS model
([ADR-0056](../../docs/adr/0056-model-description-discovery-validation-and-contract-diff.md)),
all reading `describeModel(registry)` from `@typesys/core`:

```ts
import { describeModel } from "@typesys/core";
import { compactCatalog, discover, validateQuery, diffModels } from "@typesys/devkit";

const model = await describeModel(registry);
compactCatalog(model);                                  // every Type and Action, a few lines each
discover(model, "close a work order", { limit: 3 });    // ranked, each with a compact summary
validateQuery(model, { type: "airforce.Aircrft" });     // [{ code: "unknown-type", path: "/type", suggestion: "airforce.Aircraft", ... }]
diffModels(before, after);                              // { changes: [{ impact: "breaking", ... }], underVersioned: [...] }
```

Over MCP: `typesys_discover` and `typesys_validate_query`. From the shell:

```bash
npx typesys describe ./fleet --bindings ./fleet/bindings.mjs --out model.json
npx typesys diff model.json new-model.json          # exits 1 on a breaking or under-versioned change
npx typesys discover ./fleet vehicles that need service
npx typesys check-query ./fleet query.json --json
```

Discovery is lexical (BM25 over the model's own words); validation checks
the model, never what a caller may read; the diff judges the declared
contract, not behavior behind it.
