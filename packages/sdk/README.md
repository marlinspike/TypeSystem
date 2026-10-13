# @typesys/sdk

A typed, governed TypeScript client for TypeS, generated from the model
([ADR-0055](../../docs/adr/0055-typed-sdk-generated-from-the-registry.md)).

```ts
import { createClient, runtimeTransport } from "@typesys/sdk";
import type { AirforceModel } from "@typesys/domain-airforce";

const af = createClient<AirforceModel>(runtimeTransport(runtime, identity));
const rows = await af
  .from("airforce.Aircraft")
  .where((a) => a.needsAttention.eq(true))
  .include("components", (c) => c.select("partNumber"))
  .page();
```

Names are checked by the compiler, rows are typed (every value optional,
since policy may withhold any of them), and a query is only ever the
`SemanticQuery` it builds: the runtime validates, authorizes and audits it
for this caller, in process (`runtimeTransport`) or over MCP
(`mcpTransport`). Generate a model with `generateModel(await describeModel(registry))` or
`typesys generate-sdk`.

See [`docs/how-to/use-the-typed-sdk.md`](../../docs/how-to/use-the-typed-sdk.md).
