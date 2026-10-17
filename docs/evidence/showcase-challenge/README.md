# The recall-response challenge: what happened, and what it shows

On 2026-10-17 Claude Code solved an engineering task it had not seen, over a system TypeSystem had never been told about, and two independent Claude Code subagents solved the same task in sealed sandboxes, one with TypeSystem's development tools and one without. Everything below is measured from those runs; the transcripts, the applications the subagents wrote and the scores are in this directory.

## The task, written first

An independent subagent wrote the challenge before any solution existed ([authoring-transcript.md](authoring-transcript.md), [AUTHORING.md](AUTHORING.md)). It added a fourth independent service, an industry recall exchange (`examples/services/recall-exchange`: plain Node, HTTP Basic, numbered paging, every answer wrapped in `{data, meta}`, its own vocabulary such as `CLASS_II` and `EMBARGOED`), wrote the requirement (`packages/evaluation/tasks/recall-response/requirement.md`) and 16 hidden acceptance checks (`packages/evaluation/hidden/recall-response.mjs`). It wrote no model, mapping, policy or application code, and checked that an application refusing everything, and one allowing everything, pass none of the 16.

The requirement crosses four systems. A logistics coordinator asks to respond to a manufacturer's recall; the application reads the notice from the exchange, finds our lots in the pharmacy inventory, checks the product code matches, asks the shipment tracker (not the inventory) which shipments are in transit, and waits for a quality-assurance pharmacist who is not the requester to sign off. Only then are the lots quarantined and the response filed with the exchange; a failed filing releases the lots. Embargoed notices are need-to-know for quality assurance, the health hazard evaluation is CONFIDENTIAL, carriers read no notice at all, and a terminated, already-answered or mismatched notice fails without changing anything.

Nobody who built a solution read the hidden checks. The sandboxes withhold them (`packages/evaluation/src/sandbox.ts`), and this session did not open the file.

## The three solutions

| | Built by | Tools allowed | Wall time | Tokens | Tool calls | Hidden checks |
| --- | --- | --- | --- | --- | --- | --- |
| Without TypeSystem's tools | Claude Code subagent, sealed sandbox | `@typesys/core`, the adapters, the cold-chain package; write the API, workflow and approvals by hand | 7 min 43 s | 172,383 | 35 | **16 / 16** |
| With TypeSystem's tools | Claude Code subagent, sealed sandbox | Everything, including the compiler, `typesys app` CLI, onboarding and the engineer skill | 11 min 26 s | 212,144 | 61 | **16 / 16** |
| This repository's `examples/apps/recall-response` | Claude Code, this session | Everything, plus permission to change the platform | about 23 min to 16/16, including platform changes | not separately metered | — | **16 / 16** |

Times and tokens for the two subagents are the harness's own figures ([arms/](arms/)); both started at 19:30:52Z with the same model and the same prompt apart from the sandbox. This session's time runs from the first onboarding command (19:31:08Z, [transcript/01-discover.txt](transcript/01-discover.txt)) to the 16/16 score (19:54:05Z, [transcript/06-score.txt](transcript/06-score.txt)); it includes writing ADR-0096 to ADR-0098 and their code, which the subagents could not do. Its first score, at 19:53:45Z, was 0/16 because the application's build script called a binary the scoring sandbox does not link; the fix was one line.

**The hidden checks did not separate the three.** Every solution passed every check, so on this task pass rate says nothing about the tools. The tools arm was slower and used more tokens than the baseline. That is the honest headline.

## What did differ

Each arm wrote its own report ([with](arms/agent-with-transcript.md#report-to-the-caller), [without](arms/agent-without-transcript.md#report-to-the-caller)), and the code is kept under [arms/](arms/).

**Neither subagent could extend the governed host.** `buildColdChainHost()` returned a runtime with no way to add a fourth source. The baseline rebuilt the runtime from the package's exported parts, with a 5-second call timeout where the host uses 2; the tools arm built a second runtime beside the host and left the host's unused. Both are reasonable workarounds and both duplicate governance configuration that should live in one place. The platform now has the extension point (`ColdChainHostOptions.extend`, used by `buildRecallHost`).

**Both arms enforced "only after sign-off" in their own code.** The tools arm gave its Actions a policy that admits a call only while its workflow is invoking them for a run, a flag set by its own code. The baseline wrote its own workflow engine and exposed no Action endpoint at all, so the guarantee is the shape of its hand-written server. Either stops a direct call through that application, but neither stops another application or a workflow that forgets its approval step, and neither is visible to a checker. ADR-0096 makes it a property of the Action: `requiresApproval: true` is refused outside a workflow step that follows a granted approval, the compiler reports `approval-required` when a page would call such an Action, and the workflow validator reports `unapproved-action` for a flow that invokes one without an upstream approval.

**The tools arm did not use the compiler.** Its report says the engineer's mission format "cannot express this workflow's loops over lots", so it hand-wrote the flow with `@typesys/workflow` and the API with `@typesys/http`. This session used the 4.0 compiler: the response is a declarative flow in `app.json` (read, compute, check, forEach, approval, action with compensation) plus 44 lines of TypeScript for the NDC and in-transit rules, and the compiler checked it before it ran. The compiler did refuse two things on the way, and both were fixed in the platform rather than worked around: a list-typed Action input generated as a readonly array (TS4104), and the lack of a way to say a run is about one object, so a requester who may not read the notice is refused at the start (ADR-0097).

**The judgement calls the requirement left open were made differently.** The baseline answers an unknown recall with `201 failed`, the tools arm treats a rejected sign-off as `rejected`, and the baseline lets the signer see a finished run. The hidden checks deliberately left these untested ([AUTHORING.md](AUTHORING.md), "Left untested").

## The lifecycle, stage by stage

| Stage | Evidence |
| --- | --- |
| A. Discover and connect | [01-discover](transcript/01-discover.txt), [02-onboard](transcript/02-onboard.txt): onboarding collected 3 entities, 4 operations and 28 facts from the exchange's OpenAPI document, then proposed no Type at all: every answer is an envelope and the schemas use `oneOf`. ADR-0098 taught the HTTP adapter and onboarding that shape; the second proposal offered `coldchain.Notice`, its properties and the `FileResponse` Action, all pending an expert's review, none approved on its own. |
| B. Understand | [03-understand](transcript/03-understand.txt): `typesys app context`, `why` and `inspect` as the coordinator and as quality assurance. |
| C. Build | [04-build](transcript/04-build.txt): `check` (one error: `pluck` of `$id`), `compile`, `build` (TS4104, fixed in the compiler), then a clean build. |
| D. Operate | [05-verify](transcript/05-verify.txt): 22 of 22 acceptance checks as every caller, through the API and in Chromium. |
| E. Evolve | [07-evolve](transcript/07-evolve.txt): the embargo condition removed from the read policy ([change.diff](evolve/change.diff)). `typesys app impact` reported a governance change and 28 new exposures and exited 1; `verify` then failed 5 checks; restoring the rule gave "No change" and a passing verify. The first impact run reported only the predicted change, because it probed a public notice; ADR-0099 makes impact probe the objects the application's own checks name, and the second run caught the exposures. |
| F. Verify | This report and [06-score](transcript/06-score.txt). |

## What this does not show

One task, one run per arm, one model family: none of the timings is a distribution, and an arm run again could come out the other way. The hidden checks were written by Claude too; a check suite that every solution passes cannot rank them. The two subagents and this session differ in more than their tools: this session could change the platform and had read more of the repository beforehand, so its time is not comparable with theirs. No human engineer took part, so nothing here measures human productivity; the earlier estimate in `docs/evidence/` remains an estimate.

What the run does show is narrower and, we think, more useful. A new system with its own authentication, paging and vocabulary went from an OpenAPI document to a governed, approval-gated application over four systems in one session. Two independent builders hit the same gaps in the platform, and those gaps were then closed in the platform (ADR-0096 to ADR-0099) instead of in each application. And when the model changed in a way that exposed confidential data, the tooling said so before anything was deployed.
