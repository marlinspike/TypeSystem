# Drafting missions from words, measured without paid runs, 2026-10-16

This records what `typesys engineer draft` (ADR-0077) produced on the three
evaluation tasks of ADR-0073, and what running it against a configured
provider would take. No model API was called. Every figure is marked
**measured** (run on branch `claude/llm-integration-f45873`, Node 22) or
**estimated** (with its basis).

## Who wrote the answers

The development model in every run below was the coding agent working on
this branch, in agent mode: it read the request `draft` wrote, answered it
as JSON, and `draft` checked the answer exactly as it checks a provider's.
The agent was given each task's public `requirement.md` only, and did not
read the hidden checks before drafting. It had, however, seen the
reference missions for these tasks earlier in the same working session, so
these results are an upper bound on what a model with no such exposure
would score, not a measurement of one.

## Results

| Task | Rounds | Errors after round 1 | `verify` | Hidden checks |
| --- | --- | --- | --- | --- |
| component-replacement | 1 | 0 | 15 of 15 | **14 of 14** |
| requisition-expedite | 1 | 0 | 15 of 15 | **14 of 14** |
| sortie-confirmation | 1 | 0 | 16 of 16 | **15 of 15** |

All **measured**. Each drafted spec was scaffolded with no hand edits,
verified, and scored by `npm run evaluate -- score --arm agent-with
--source agent`. That is 43 of 43 hidden checks with no human
intervention after the brief was written. The brief (requirement, host,
callers, author, policy rules, agent audience) is the person's part, as
ADR-0077 requires.

The briefs, the agent's answers and the scores are in
[`llm-drafting/`](llm-drafting/). Replaying one reproduces its spec
byte for byte, which was checked for sortie-confirmation:

```sh
cd docs/evidence/llm-drafting/sortie-confirmation
typesys engineer draft brief.json --out mission.json --answer 1.json
typesys engineer scaffold mission.json --out app && typesys engineer verify app
```

## Tokens per drafting

**Measured** from each run's `.draft.json`, with tokens estimated by the
model layer at four characters a token (agent mode has no tokenizer, so
`estimated: true` is recorded on each call):

| Task | Context (Types, Actions) | Context tokens | Request in | Answer out |
| --- | --- | --- | --- | --- |
| component-replacement | 10, 2 | 1,433 | 2,851 | 1,171 |
| requisition-expedite | 9, 0 | 1,126 | 2,520 | 981 |
| sortie-confirmation | 9, 0 | 1,169 | 2,605 | 980 |

The request is the context plus the drafting rules, the brief and the
answer schema. On a provider the true counts depend on its tokenizer; the
four-character estimate is commonly within a few tens of percent for
English and JSON, so treat these as the order of magnitude, not a bill.

## What a paid run would take

**Estimated, as a formula, not a price.** One drafting of round count
*r* costs

    Σ (inᵢ × p_in + outᵢ × p_out),  i = 1 … r

where *p_in* and *p_out* are the provider's per-token prices on the day
of the run. Here *r* was 1 on every task. When a round fails, the next
re-sends the whole request plus the previous answer and its errors: the
fleet-readiness example (ADR-0077) went from about 2,500 to 3,300 tokens
in from round 1 to round 2. With the default limit of three rounds, one
drafting on these tasks is bounded at roughly 2,500 to 13,000 tokens in
and 1,000 to 3,600 out. All three tasks once is about 8,000 in and 3,100
out at one round each. Prices are not quoted here because they change and
were not verified for this document; multiply by the current price list.

A local model (Ollama, LM Studio, vLLM) costs no per-token charge. Whether
a smaller local model drafts these in one round was not measured: the
cloud container blocks model downloads, so that run belongs on a machine
with a model installed (opt-in, with `TYPESYS_LLM_LIVE_CONFIG` naming the configuration).

## Finding: what the model is granted decides what it can draft

The first requisition-expedite brief granted the agent a viewer's
audience. Drafting read the context as the author reading for that
audience, so the agent was told that `ops.Requisition` exists but was
shown no requisition, and `missionCapability` was marked not returned
(the request is kept as
[`viewer-audience.request.txt`](llm-drafting/requisition-expedite/viewer-audience.request.txt)).
Without an awaiting requisition's id, no acceptance check for "a planner
approves an expedite" can be written. That is the release rule working
as designed (ADR-0075), not a defect.

The briefs used for the results grant the agent a maintainer's audience
in the owning unit (`roles: ["maintainer"]`, `UNCLASSIFIED`, unit
`388FW`), which sees the requisitions and aircraft the checks need and
still not the crew's names. Choosing that audience is a deployment
decision the brief's author makes: grant a drafting model the least
audience under which the mission's own objects are visible.

## Also found and fixed

Running `typesys engineer plan` and `draft` against the sortie host hung
after printing its result: the host starts three services of its own and
the commands never stopped them. Both commands now stop a loaded host's
services when they finish, and the `typesys` binary exits once a
delegated command returns. This predates the LLM work.
