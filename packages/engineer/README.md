# @typesys/engineer

The TypeSystem engineering loop
([ADR-0071](../../docs/adr/0071-the-engineering-loop-verifies-against-the-runtime.md)).
A mission spec states a requirement, the people it serves, and acceptance
checks the governed runtime can decide. `plan` reads the spec against the
model, `scaffold` writes a typed application from it, and `verify` builds
and starts that application, then runs every check through its API as
each caller. Each problem comes back as a diagnostic with a code, a
location and a fix hint, so an agent can repair from it.

```
typesys engineer plan examples/missions/component-replacement/mission.json
typesys engineer scaffold examples/missions/component-replacement/mission.json --out apps/component-replacement
typesys engineer verify apps/component-replacement
```

```ts
import { verifyMission } from "@typesys/engineer";

const report = await verifyMission("apps/component-replacement");
report.ok;            // plan, build and every acceptance check passed
report.diagnostics;   // [{ code: "check-failed", at: "acceptance/11", message, hint }, ...]
```

The same operations are MCP tools (`typesys-engineer-mcp <root>`, over
stdio) and a Claude Code skill (`.claude/skills/typesys-engineer`). Each
surface returns the same JSON, so any agent can drive the loop.

`verify` runs the application and the host module its spec names, so treat
a spec from someone else as you would their code.
