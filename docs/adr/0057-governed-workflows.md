# 0057. Governed Workflows: a Journaled Interpreter over the Runtime

## Status

Accepted — implemented in the new `@typesys/workflow` (`defineWorkflow`,
`WorkflowEngine`, `validateWorkflow`, `InMemoryJournal`, `simulate`,
`replay`), `@typesys/devkit` (`synthesize`, `synthesizeObjects`), and
`@typesys/domain-airforce` (the `airforce.GroundForRepair` workflow, the
`airforce.maintenance-lead` rule in ABAC and Cedar, and a `lead` demo
identity). Proven by:

- `packages/workflow/test/workflow.test.ts`: a run reads as its initiator,
  gives the model only what its step selects (no SECRET value reaches it),
  waits for an approval, and opens and starts the work order as the
  initiator, audited as theirs; an aircraft that needs no attention skips
  every later step and never calls the model; the start policy and the
  input schema refuse before anything is journaled. The initiator cannot
  approve their own run, an approver the policy does not admit is refused,
  both refusals are audited, and of two concurrent decisions exactly one is
  recorded. A model answer outside its schema fails the step (and is
  retried where the step allows); one naming another aircraft's event is
  stopped by a deterministic check before any approver or Action sees it.
  The definition check refuses an Action with side effects fed by an AI
  step no approval reviewed, a retried non-idempotent Action, an unknown
  Action and a read of a later step. Retries happen only for retryable
  errors, with backoff; a later failure closes the work order opened
  earlier; a failed compensation leaves the run for a person; a new engine
  over the same journal finishes a run without asking the model again; a
  non-idempotent Action whose outcome was lost in a crash is never repeated
  (the run goes to `needs-reconciliation`), while a naturally idempotent
  one is; an initiator whose roles were revoked while the run waited acts
  with what they hold now. Replay accepts the recorded run under its own
  definition and names the step where a changed one diverges; the engine
  refuses to resume or approve under a diverging definition.
- `packages/workflow/test/simulate.test.ts`: a simulation reads for real,
  previews every Action (audited as previews, no `invokeAction` row, no
  work order created), reports an Action whose target the simulation
  invented as unchecked rather than passed, records the policy's refusal of
  a scripted approver, and recovers from injected crashes from its journal.
  Start and approval decisions are identical under `AbacPolicyEngine` and
  `CedarPolicyEngine` for six identities, spoofed role names included.
- `packages/workflow/test/types.test.ts`: five compile-time refusals (an
  Action not in the model, an input missing a field or with a status the
  Action does not accept, a read of a Type not in the model, a run input
  field that does not exist), and a compensation typed by the output of the
  Action it undoes.
- `packages/devkit/test/synthesize.test.ts`: every value synthesized for
  every value, computed value, Action input and Action output schema of
  both demo models, over 50 seeds, is admitted by its schema; a keyword it
  cannot honor is refused; synthetic objects seeded into a source are
  governed like any other (the viewer still gets no SECRET value).

Mutation-checked (11 mutations): any approval counted as review; four-eyes
removed; a lost non-idempotent outcome re-invoked; every error treated as
retryable; compensation skipped; replay ignoring a changed compute step;
undeclared reads allowed; simulation invoking instead of previewing; the
approver's policy ignored; outputs given to someone other than the
initiator; the engine advancing without the replay check. Each fails at
least one test.

## Context

The baseline found no workflow model: approvals, retries, idempotency and
compensation were each application's own code, written around the runtime
rather than through it. The mandate adds AI steps, which make the question
sharper: a model's answer is a proposal, and nothing about calling a
governed Action stops a workflow from committing it unreviewed.

Mature durable-execution engines exist. Temporal runs workflows as code
whose history is replayed deterministically; DBOS Transact checkpoints each
step to Postgres from a library. Neither knows what TypeSys knows: which
steps are authoritative and which are a model's guess, who a step acts as,
which Actions have side effects and whether repeating one is safe, or who
may approve. Building another general orchestrator would duplicate them;
having none leaves every application to rebuild the governed part.

## Decision

**A workflow is a declared list of typed steps, and `needs` is its data
flow.** Five kinds: `read` (through the typed SDK client as the
initiator), `compute` (a pure function), `ai` (an `AiModel` behind a
seam), `approval` (a policy decides who), and `action` (a governed Action,
with an optional compensating Action). A step's functions see the run's
input and the outputs of the steps it lists in `needs`, and reading any
other step's output fails the step, so `needs` is exactly where its data
came from. Typed by the generated model (ADR-0055), an Action step's input
and its compensation's input are checked by the compiler.

**An AI output reaches a side effect only through a person.** At
registration, an Action step with side effects whose `needs`, followed
transitively, include an AI step must also include an approval that itself
depends on that AI step. Otherwise the workflow is refused. Deterministic
checks of the model's answer belong in compute steps between them (the demo
refuses an event that is not this aircraft's). A model's answer is checked
against the step's `outputSchema` and journaled as the model's (`source:
"model"`, with the model's id), never as fact.

**The run acts as its initiator; the engine decides nothing the runtime
decides.** Reads and Actions go through `SemanticRuntime` with the
initiator's identity, so policy, classification, preconditions and audit
apply as if the person had made each call. Starting a run is itself a
policy decision (`startPolicy`), and so is each approval, on resource `{
typeName: <workflow>, actionName: <step> }`. The initiator may not approve
their own run unless the step says so. Outputs go to the initiator only; an
approval's presentation goes only to an approver its policy admits; the
run's status shows where it is and how each step ended, never a value. A
host may re-resolve the initiator each time a run advances, so revoked
roles take effect mid-run. The engine writes its own audit rows (`operation:
"workflow"`) for starts, approval decisions and views, and finishes.

**State is a journal, and the journal is the trace.** Every event (start,
step started with its Action and input, completed with its output and
source, failed, skipped, approval requested and decided, compensation, end)
is appended to a `WorkflowJournal`, whose `append` is conditional on the
run's length, so two processes cannot both advance a run. A run's state is
a fold of its journal. On restart the engine resumes from the journal
alone: recorded reads, model answers and Action outputs are reused, never
repeated. A step started with no outcome recorded is retried if it has no
side effects or its Action is idempotent (`natural` or `key`, with
`ctx.idempotencyKey` stable across attempts and restarts); for an Action
whose idempotency is `none` the engine cannot know whether it ran, and the
run stops at `needs-reconciliation` rather than risk doing it twice.
Retries apply only to errors that say they are retryable, never to a
refusal or bad input, and a retry policy on a non-idempotent Action is
refused at registration. When a step fails or an approval is rejected, the
compensations of completed Action steps run newest first; one that fails
stops the run at `needs-reconciliation`.

**Replay is a check, run before every advance.** `verifyReplay` re-runs
the definition over a recorded journal without effects: the same steps of
the same kinds, skipped or run as before, every compute step returning what
it returned, every Action and AI step given the same input. The engine runs
it before it advances or records a decision, so a run never continues under
logic that would not have produced its history; CI can run `replay` against
recorded journals before a new version ships. Versions are explicit: a run
finishes on the version it started on.

**Simulation is the same engine with previews.** `simulate` runs a
definition against the real runtime as the initiator: reads are real,
Actions are previewed (ADR-0053) and never invoked, with outputs
synthesized from their schemas (`synthesize`, which refuses keywords it
cannot honor); model answers and approval decisions come from a script, and
each scripted approver is still decided by the real policy. Faults inject
errors or crashes before or after any step's effect, or a compensation's;
after a crash the simulation resumes from the journal, as a restarted
process would. Its result is the run and its journal.

**Durability sits behind the journal, and mature engines are the
production answer.** The reference journal is in memory. A durable one is
any store that appends conditionally by `(run_id, seq)`. For long-running
production workflows the mapping is: a TypeSys workflow step becomes a
Temporal activity or a DBOS step, the journal becomes that engine's
history or checkpoint table, and the governance (`needs`, the AI-review
rule, policy-decided approvals, initiator identity, idempotency-aware
recovery, replay checks) stays in `@typesys/workflow`, which validates and
interprets the same definition. Neither binding is implemented in this
slice.

## Consequences

- A workflow that commits a model's proposal without review cannot be
  registered, and one that acts beyond its initiator's authority fails at
  the step that tries, audited as a deny.
- A crash never repeats a non-idempotent Action; it costs a person a
  reconciliation instead. The engine cannot tell "crashed before the call"
  from "crashed after it", and assumes the worse.
- The journal holds the initiator's identity and everything the run read
  and produced. It is as sensitive as the data and must be protected like
  the audit log; status views carry none of it.
- An approver sees what the run read as the initiator, filtered only by
  what the step presents; the approval policy is what admits them to it.
- Measured on the demo (in-memory sources, Node 22, 300 runs): a full run
  of the eight-step workflow costs about 0.9 ms more at p50 than the same
  reads and Actions called directly (8.8 ms against 7.9 ms in two runs),
  for 19 journal events, two policy decisions and three audit rows of its
  own. See [`evidence/workflow-2026-10-13.md`](../evidence/workflow-2026-10-13.md).
- Not yet: a durable journal (Postgres, or a Temporal or DBOS binding);
  durable timers (a retry's backoff sleeps in process) and approval
  deadlines; a check that data sent to a model is within what that model
  may receive (classification is enforced on reads, not on the model as a
  sink); parallel steps; sub-workflows.

## Alternatives Considered

- **Adopt Temporal or DBOS as the engine now.** Either needs
  infrastructure (a Temporal cluster; Postgres for DBOS) in every test and
  demo, and neither knows the governance this ADR adds, which would still
  have to be written. The journal seam keeps that choice open per
  deployment without changing a definition.
- **Workflows as plain async functions with checkpoints (DBOS style).**
  Natural to write, but the engine could not see the data flow, so the
  AI-review rule and replay checks would rest on convention. Declared steps
  with `needs` make both mechanical.
- **An AI step that may invoke Actions itself (tool use).** Rejected:
  a probabilistic step that commits is exactly what the review rule
  forbids. An agent proposes through an AI step; a governed Action commits
  after review.
- **Retry everything a bounded number of times.** A timeout after a write
  is the common case where a retry duplicates it; retries are therefore
  per step, only on retryable errors, and refused for non-idempotent
  Actions.

## Amended 2026-10-13 (pressure test)

An independent review found five ways around the guarantees above; each is
now closed and has a test in `packages/workflow/test/pressure-workflow.test.ts`.

- **An approval's condition could skip the review it exists for.** An
  approval with a `when` that reads the model's answer let the model decide
  whether a person saw it. The definition check now counts an approval as
  reviewing an AI step only when it has no condition or the AI step's own
  condition, and the engine (and replay) never skip an approval downstream
  of an AI step that ran.
- **A read step could invoke Actions.** Its SDK client could call
  `action(..).invoke`, bypassing the review rule, the journal's no-replay
  rule and, in `simulate()`, the promise to change nothing. Read steps now
  get a client whose `invokeAction` throws.
- **Compensations were not checked.** A side-effecting compensation fed by
  AI output now needs the same review as the step's own Action.
- **An approver saw what the initiator could read.** `pendingApproval` now
  re-reads every object in the outputs (anything with `$id` and `$type`) as
  the approver and keeps only the values that read returns. What a compute
  or AI step derived from a withheld value is not covered: keep such steps
  out of an approval's `needs`.
- **A timeout after a write was reported as `failed`.** A non-idempotent
  Action whose last error was retryable (outcome unknown) now ends the run
  as `needs-reconciliation`, also after a restart.

Run status (`status(runId, viewer)`) is now shown only to the initiator or
an approver the waiting approval admits; anyone else, and a missing run,
get `NotFoundError`. `approvalsFor` no longer audits a denial for each run a
listing passes by.
