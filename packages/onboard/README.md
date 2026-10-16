# @typesys/onboard

Describes existing PostgreSQL databases, OpenAPI services and JSON
Schemas as TypeSystem Types
([ADR-0076](../../docs/adr/0076-onboarding-proposes-from-evidence-and-an-expert-approves.md)).
It reads only metadata, proposes from it with every item citing its
evidence, lets a development model refine the proposal under checks it
cannot get around, and builds and verifies only what an expert approved.
A rerun after a source changes keeps everything approved and asks only
about what changed.

```
typesys onboard collect --postgres MXDB_URL --schema mx --source mxdb --out sources.json
typesys onboard propose sources.json --domain mx --out onboarding/
typesys onboard review onboarding/ --review review.json --by "J. Rivera" --accept-rest
typesys onboard propose sources.json --domain mx --review review.json --out onboarding/
typesys onboard check onboarding/
```

```ts
import { fromPostgres, introspectPostgres, onboard } from "@typesys/onboard";

const sources = [fromPostgres(await introspectPostgres(pool, ["mx"]), { source: "mxdb", system: "MXDB" })];
const run = await onboard({ domain: "mx", sources, model, review, approved });
run.review.pending;        // what still needs a decision
run.verification.pack;     // the approved model as a pack, installed and checked
run.verification.built;    // adapter plans and the policy rules to write
run.metrics;               // proposed, refused, approved, pending; tokens and latency
```

`model` is any development `LanguageModel` from `@typesys/llm`, or the
coding agent you are working with (`typesys onboard request`, then
`propose --answer`). See
[onboard a source](../../docs/how-to/onboard-a-source.md) and
`npm run onboard:demo`.

`typesys-onboard-mcp <root>` offers `collect`, `request` and `propose` as
MCP tools over stdio, for a coding agent acting as the development model.
Every path is confined to `<root>`, and a database's connection string is
read only from the server's environment, by the variable the agent names.
