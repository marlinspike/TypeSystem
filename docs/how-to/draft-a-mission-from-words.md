# Draft a mission from words

`typesys engineer draft` (ADR-0077) writes a mission spec from a
requirement in words. A development model proposes the Types and Actions
the application uses, its views, an optional workflow and its acceptance
checks. TypeSystem plans every answer against the governed model and
sends the problems back until none is left. You review the checks, then
scaffold and verify as with a hand-written spec
([compose a mission application](compose-a-mission-application.md)).

## See it work

```sh
npm run build
npm run draft:demo
```

The demonstration replays the drafting of
`examples/missions/fleet-readiness-board` from its brief, with the coding
agent's two recorded answers and `verify`'s feedback on the first, then
scaffolds the application and verifies it: ten checks, each run through
the application's own API as each caller.

## Write a brief

The brief is yours, and everything in it that grants authority stays
yours: the model cannot change the host, the callers, or the policy rules
a workflow may be gated by.

```json
{
  "format": "typesys.mission-brief/1",
  "requirement": "A fleet readiness board for the squadron. Maintainers see …",
  "host": { "module": "@typesys/domain-airforce", "build": "buildAirforceTestbed", "identities": "resolveDemoIdentity", "workflows": "airforceWorkflows" },
  "callers": {
    "maintainer": { "token": "demo-maintainer-token", "description": "SSgt Rivera, a maintainer" },
    "viewer": { "token": "demo-viewer-token", "description": "a read-only viewer" },
    "anonymous": { "token": "", "description": "someone not signed in" }
  },
  "author": "maintainer",
  "policies": { "airforce.maintainer-only": "maintainers" },
  "agentAudience": { "roles": ["viewer"], "clearance": "UNCLASSIFIED" }
}
```

`author` is the caller the model is told about the model as. It is told
what the author may share with it, which the runtime decides from
`agentAudience` (ADR-0075): here, what a viewer cleared to UNCLASSIFIED may
see. Without `agentAudience` the model is granted nothing, and is told
only what needs no grant, with no example objects.

## Draft with the coding agent you are using

With no `--model`, the coding agent is the development model:

```sh
typesys engineer draft brief.json --out mission.json
# exit 2: the request is in mission.request.txt
```

Read `mission.request.txt`, write the answer as one JSON object matching
the schema at its end, and run again with it:

```sh
typesys engineer draft brief.json --out mission.json --answer 1.json
```

If TypeSystem finds problems (an unknown Type, a caller no check runs as,
a policy rule the brief does not list), the command exits 2 again with a
new request carrying them. Answer it and pass every answer, in order:
`--answer 1.json --answer 2.json`.

When the draft plans cleanly, scaffold and verify it. If a check fails
against the real data, send `verify`'s output back as feedback, with a
place for one more answer:

```sh
typesys engineer verify apps/fleet-readiness-board > verify.txt
typesys engineer draft brief.json --out mission.json --answer 1.json --feedback verify.txt
# exit 2: answer the feedback, then add --answer 2.json
```

A check present in one answer and missing from the next is reported as
`check-dropped`. Read those: removing a failing check is the easy way to
make it pass.

`mission.draft.json` records each round (answer, feedback, diagnostics,
tokens) and the recordings, so the drafting can be replayed exactly.

## Draft with a configured model

```sh
typesys engineer draft brief.json --out mission.json --model drafting --llm-config typesys.llm.json
```

`drafting` is a model in your `typesys.llm.json` with `uses:
["development"]` ([release data to models](release-data-to-models.md)).
Its own `audience` decides what it is told. A configured model answers
every round itself: up to three, plus one for each `--feedback`.

## From an agent, over MCP

`typesys-engineer-mcp <root>` offers `typesys_engineer_draft` with
`brief`, `out`, `answers` and `feedback` (paths inside the root). It
returns `{ answerNeeded: true, request }` until it has every answer it
needs, then the draft's result.

To write code against TypeSystem rather than a mission spec, call
`typesys_compile_context` on the governed MCP server (ADR-0078): it
returns the part of the model a task needs, as your caller sees it.
