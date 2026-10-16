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

`draft` writes the spec from a brief: a requirement in words, the host,
the callers and the policy rules a workflow may name
([ADR-0077](../../docs/adr/0077-a-mission-is-drafted-from-words-and-typesystem-decides.md)).
A development model proposes the rest; the planner's errors and
`verify`'s output go back to it until none is left; a person reviews the
checks. With no `--model`, the coding agent you are working with answers:
the command exits 2 and writes the request to `<out>.request.txt`, and you
run it again with `--answer`.

```
typesys engineer draft brief.json --out mission.json                     # exits 2: answer mission.request.txt
typesys engineer draft brief.json --out mission.json --answer 1.json     # drafts, plans, reports
typesys engineer draft brief.json --out mission.json --answer 1.json --answer 2.json --feedback verify.txt
```

See [draft a mission from words](../../docs/how-to/draft-a-mission-from-words.md)
and `npm run draft:demo`.

The same operations are MCP tools (`typesys-engineer-mcp <root>`, over
stdio) and a Claude Code skill (`.claude/skills/typesys-engineer`). Each
surface returns the same JSON, so any agent can drive the loop.

`verify` runs the application and the host module its spec names, so treat
a spec from someone else as you would their code.
