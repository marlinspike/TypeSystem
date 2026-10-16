# 0077. A Mission Is Drafted From Words, and TypeSystem Decides

## Status

Accepted (2026-10-16). Builds on ADR-0071 (the engineering loop), ADR-0074
(models), ADR-0075 (release to models), ADR-0076 (agent mode) and
ADR-0078 (the context compiler). Implemented in
`packages/engineer/src/draft.ts`, the `typesys engineer draft` command and
the `typesys_engineer_draft` MCP tool, with `answeringModel` and
`recordedModel` in `packages/llm/src/agent.ts`. Proven by
`packages/engineer/test/draft.test.ts`, `surfaces.test.ts`, and `npm run
draft:demo`, which CI runs.

## Context

ADR-0071 made a mission spec the unit of application engineering: a
requirement, the Types and Actions it uses, an optional workflow and
views, and acceptance checks that `verify` runs through the generated
application's own API, as each caller. Writing that spec by hand is the
slow part, and it is the part a language model is good at: reading a
requirement and the model, and naming what an application needs and what
should be true of it.

It is also where a model is most dangerous. A spec chooses the host
application, the identities checks run as, and the policy rules a
workflow is gated by. A model that can choose those can write a mission
that passes by testing nothing, or by running as someone it should not.
And the model must be told about the governed model to write anything
useful, so what it is told is itself a release decision.

## Decision

**A brief, written by a person, owns everything that grants authority.**
`typesys.mission-brief/1` carries the requirement, the host (module,
builder, identities), the callers and their tokens, the brief's author
(one of the callers), the policy rules a workflow may name, and
optionally the audience the deployment grants the drafting model. The
model's answer is closed (`MISSION_DRAFT_SCHEMA`, `additionalProperties:
false` at the top) to the spec's name, `uses`, `workflow`, `views` and
`acceptance`. `assembleMission` takes the requirement, host and callers
from the brief, never from the answer; an answer that tries to set them
fails the model layer's schema check (`invalid-output`).

**The model is told what its author may share with it.** Drafting reads
the model context (ADR-0078) as `withAudience(author, model.audience)`:
the author reading for the model, decided by the runtime under ADR-0075.
A model granted nothing is told only what needs no grant, and is shown
no example objects. The prompt says so in words, so the model does not
take the absence of a value for its absence from the data.

**Every answer is checked by the tools that check a hand-written spec,
plus the draft's own rules.** `draftProblems` runs `missionProblems` and
`planMission` against the loaded host, then adds two rules a model left to
itself breaks: a caller with no check (`caller-unchecked`) is an error,
not a warning, and a workflow naming a policy rule the brief does not
list is `unknown-policy`. Errors, with their location and the planner's
hint ("did you mean …?"), go back to the model, which answers again with
the whole spec, for up to `maxRounds` rounds (default three).

**What `verify` says comes back too.** A spec that plans cleanly can still
fail its checks against real data. `--feedback` sends `verify`'s output
(or a reviewer's correction) to the model as a further round. A check
present in one answer and missing from the next is reported as
`check-dropped`, so removing a failing check is never a silent fix.

**The result is a proposal.** `ok` means no error is left; a person still
reviews the acceptance checks before scaffolding. `<out>.draft.json`
records every round (answer, feedback, diagnostics, tokens, latency) and
the recordings, so a drafting is replayed exactly by `recordedModel`.

**Agent mode works the same way.** With no `--model`, the coding agent is
the development model. `answeringModel` serves its answers in order,
records each against the request it answers, and when they run out fails
the request (`unavailable`, not retried) and returns it through
`needed()`; the command exits 2 and writes `<out>.request.txt` for the
agent to answer. The agent is declared `hosted`, for development only, so
release under ADR-0075 treats it as the hosted model it runs on.

## Consequences

- In the example (`examples/missions/fleet-readiness-board`), the agent's
  first answer planned cleanly and failed one of ten checks under
  `verify`: it assumed a component in poor condition the fleet does not
  have. With `verify`'s output as feedback the second answer passed all
  ten; the replaced check was reported as `check-dropped`. Both answers
  were written by a coding agent in agent mode and are labeled so; no
  configured provider has been run against the example from this
  repository.
- The context sent in that example was 1,202 estimated tokens; the two
  rounds were about 2,500 and 3,300 tokens in, 600 out each (estimated,
  `npm run draft:demo`).
- Not addressed: drafting a new Type or Action (a mission uses the model
  it is given; onboarding, ADR-0076, proposes new Types), drafting policy
  rule bodies (never a model's), and multi-mission plans.
