# TypeSystem

[![CI](https://github.com/marlinspike/TypeSystem/actions/workflows/ci.yml/badge.svg)](https://github.com/marlinspike/TypeSystem/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

TypeSystem (TypeSys for short) is a TypeScript library and server that sits
between the programs that use your data (applications, workflows, AI agents)
and the systems that hold it (databases, REST APIs, other services). You
describe your business objects once, say where each part of them is stored,
and write down who may see and change what. From then on every caller asks
TypeSys for objects instead of querying the stores, and TypeSys:

- reads each part of the object from whichever store holds it and joins them
  into one object;
- removes whatever this caller may not see: whole objects, single fields, and
  fields above the caller's clearance;
- records, for every value, which system and record it came from;
- lets the caller change data only through named Actions, each with its own
  permission check, input schema and preconditions;
- writes an audit record for every decision, allowed or refused.

Because all of this happens in one place, a React app, a REST client and an
AI agent connected over MCP get the same answer for the same person, and none
of them has to re-implement the access rules.

TypeSystem 5.0 makes the systems behind the model easy to understand. A
developer, or a coding agent working for one, can ask why a caller sees
what they see, where each value comes from, what is built on a Type, and
what a proposed change does to who sees what, and get the runtime's own
answer without reading the source. The section
[Understand an unfamiliar system](#understand-an-unfamiliar-system) shows
it on the Air Force and Cold Chain examples.

TypeSystem also compiles whole applications. Describe one in an `app.json`
(its data, workflows with AI steps and approvals, and screens), and
`typesys app` checks it against the model as each caller would see it,
generates an ordinary TypeScript and React application, and verifies it
through its API and in a browser. The section
[Build an application from one document](#build-an-application-from-one-document)
shows it end to end on Cold Chain Command.

## Understand an unfamiliar system

TypeSystem 5.0 answers the questions an engineer asks first about systems
they did not write, from the runtime that enforces the answers. Nothing
here is a second implementation of the rules. An explanation is the
runtime's own decision, replayed as the subject with every value
discarded (ADR-0089). Every surface asks the runtime, so an explanation
can't disagree with what the caller is actually returned.

| Question | CLI | MCP | HTTP | Studio |
|---|---|---|---|---|
| Where does each value come from, and what guards it? | `typesys app inspect` | `typesys_inspect` | `GET /api/inspection` | Model |
| Why is this caller allowed, refused or returned less? | `typesys app why` | `typesys_explain` | `POST /api/explain` | Explain |
| What depends on this, and what does it depend on? | `typesys app graph` | `typesys_graph` | `GET /api/graph` | Graph |
| What does an agent need to know to build this requirement? | `typesys app context` | `typesys_compile_context` | | |
| What does this change do, and which checks must run? | `typesys app impact` | `typesys_impact` | `GET /api/impact/baseline`, `POST /api/impact` | Impact |
| Do the links between systems resolve? | `typesys app links` | | | |

The enforcement structure (sources, policies with their rules, markings)
is itself governed. Only a developer the deployment's inspection policy
admits may see it, and only for what they could already learn of
(ADR-0088). With no inspection policy configured, nobody may inspect.
Anyone else's explanation names the kind of control that decided
(`member-policy`, `classification`, `derivation`) and never the policy
or marking.

![The semantic workbench in Studio: the Aircraft Type selected, its values with where each comes from and what guards it, its relationships, the Actions on it and the parts of the application built on it](docs/images/5.0/workbench-overview.png)

*Studio as a semantic workbench (ADR-0091), signed in as the maintenance
lead, who may inspect. It is a view onto the runtime, not an editor.*

### Why a caller sees what they see

The lead asks why the viewer is not returned three of the aircraft's
values, on the squadron maintenance application
([`packages/compiler/test/fixtures.ts`](packages/compiler/test/fixtures.ts)).
Each finding is evaluated by the runtime now, as the viewer:

```text
$ typesys app why squadron --as lead --for viewer --read airforce.Aircraft/AF86-0147
PARTIAL: user-viewer-1 is allowed this, with 3 values withheld: maintenanceStatus, deploymentLocation, readinessStatus.
  withheld  maintenanceStatus            evaluated, member-policy airforce.maintainer-only: Requires one of roles [maintainer, ai-enclave], subject has [viewer] (to change: allowed when role in [maintainer, ai-enclave])
  withheld  deploymentLocation           evaluated, classification: Requires a higher clearance (to change: the subject's clearance must dominate SECRET)
  withheld  readinessStatus              evaluated, derivation: Derived from a property the caller may not read (to change: readable only where maintenanceStatus is; or the domain releases it in x-computed, a reviewable assertion that the value does not disclose it (ADR-0052))
  returned  needsAttention               evaluated, release
This explains the decision as it is made now. The runtime decides every call again, and a later call can be decided differently.
```

*Abridged: the eight values returned with no control are left out.*

![Explaining a read in Studio: the viewer's read of AF86-0147 with each withheld value, the control that withheld it and how it could change](docs/images/5.0/workbench-explain.png)

The same question works for a relationship (`--related`), an Action with
its input (`--invoke`, nothing is executed) and a query (`--query`). A
refusal names the rule an inspector may be told. In Cold Chain, a
carrier's dispatcher asking for someone else's freight gets this:

```text
$ typesys app why examples/apps/cold-chain --as qa --for carrier --read coldchain.Shipment/SH-1046
REFUSED: user-carrier-1 is refused by object-policy: No alternative allowed: Requires one of roles
  [logistics, qa, auditor, coldchain-model], subject has [carrier]; Requires resource.carrier to match subject.carrier.
```

### What is built on what

The dependency graph joins the model, its governance and what is built on
it: the Types, values and relationships, the sources and policies, the
workflows and their steps, and every part of an application with its
acceptance checks (ADR-0090). Each edge reads "depends on". Studio shows
one neighborhood at a time, so a large model stays readable.

![The dependents of maintenanceStatus in Studio: the computed values derived from it, then the application's data, page and checks and the workflow steps that use them](docs/images/5.0/workbench-dependents.png)

One query names everything that rests on `maintenanceStatus`, directly or
through a value computed from it. No 4.0 tool could answer this.

### Context for a coding agent

`compileContext` gives an agent the part of the model a requirement
needs, as its caller is told of it, within a token budget (ADR-0092).
Every value says how it is known: no mark means the runtime returned it
to this caller, `[withheld: ...]` that the runtime decided they may not
read it, `[inferred: ...]` that it was concluded from a sample, and
`[unavailable: ...]` that it could not be determined. An Action is never
included without the Types it needs. The context also lists the parts of
the application and the workflows that already use each Type, and the
acceptance checks a change must keep passing. For the carrier on Cold
Chain:

```text
$ typesys app context examples/apps/cold-chain --as carrier
As user-carrier-1. Only what this caller is told of and returned is shown.
Model 5adda67e72395c7a. Sources, policies and markings are withheld from this caller.

TYPES
coldchain.Excursion — A time a shipment's temperature left 2–8 °C, in the sensor hub.
  [withheld: reading it was refused, for every value]
  ...
coldchain.Shipment — A refrigerated consignment, in the shipment tracker.
  origin: string — The site it left.
  destination: string — The site it is bound for.
  carrier?: string
  ...
  → originSite: coldchain.Site
  → destinationSite: coldchain.Site
  used by app cold-chain: check.anonymous-refused, check.carrier-refused-other-freight, check.carrier-sees-own-freight, data.shipments, page.Command.data.selectedShipment, page.Shipment.data.shipment and 6 more
  used by workflow coldchain.AssessExcursion: shipment, lots, readings
  used by workflow coldchain.DispositionExcursion: shipment, lots, readings
```

### What a change does before it ships

A contract diff does not see governance. Releasing `readinessStatus` to
every reader looks like a small convenience, but it maps the
maintainer-only `maintenanceStatus` one to one. No contract changes, so
no diff catches it. Change impact compares a baseline of the model and
each caller's decided reads (never their values) with the model after the
change, and maps every difference onto the graph (ADR-0093):

```text
$ typesys app impact squadron --as lead --record baseline.json            # before the change
Recorded baseline.json: 10 Types, 12 reads by 4 callers, with the inspection
$ typesys app impact squadron-proposal --as lead --against baseline.json  # after it
Change b95ad78235e8 → 152e3e9f7e65: risky, 1 new exposure
  observed widens      airforce.Aircraft.readinessStatus on airforce.Aircraft/AF86-0147: now returned to viewer, was withheld
                       reaches app:squadron-maintenance, workflow:airforce.GroundAircraft
  governance widens    airforce.Aircraft.readinessStatus: now released from maintenanceStatus: readers who may not read it are returned this value
                       reaches app:squadron-maintenance, workflow:airforce.GroundAircraft
Checks to run: part:app:squadron-maintenance/check.board-shows-attention
```

It exits 1 on an exposure, a breaking change or an under-versioned one,
so a pipeline can stop on it. `npm run impact:demo` runs this example.

![Change impact in Studio: a baseline loaded from a file, compared with the proposal, the viewer's new exposure listed first, then the release that causes it, and the check to run](docs/images/5.0/workbench-impact.png)

### Links across systems

Systems refer to each other by their own codes. Cold Chain's shipment
tracker names each end of a shipment by the pharmacy inventory's facility
code, and the runtime now reads that Site from the inventory where it
lives, with nothing copied (`byOwnField`, ADR-0094). A link probe says how
every cross-system link resolves for a caller. Dangling and refused
references are counted only when an inspector explains someone else, since
telling a caller would name what their own read leaves out:

```text
$ typesys app links examples/apps/cold-chain --as qa --for carrier --cross-source
Links as user-carrier-1, explained to user-qa-1:
  coldchain.Shipment.readings → coldchain.Reading          [shipment-tracker → sensor-hub] 3 probed, 1 not readable by user-carrier-1, 0 returned, 0 dangling, 144 refused
  coldchain.Shipment.lots → coldchain.Lot                  [shipment-tracker → pharmacy-inventory] 3 probed, 1 not readable by user-carrier-1, 0 returned, 0 dangling, 4 refused
  coldchain.Shipment.destinationSite → coldchain.Site      [shipment-tracker → pharmacy-inventory] 3 probed, 1 not readable by user-carrier-1, 3 returned, 0 dangling, 0 refused
```

*Abridged.* The carrier may read their own freight's destination Site, and
none of its telemetry or lots. A shipment the carrier may not read at all
is skipped, not counted. It exits 1 on a dangling reference. When the inventory stops
answering, a shipment is still read from the tracker, and its partial
answer names `pharmacy-inventory` as the system that failed.

### Measured

[`docs/evidence/semantic-workbench-2026-10-17.md`](docs/evidence/semantic-workbench-2026-10-17.md)
compares three arms on the same questions, with no model calls: reading
the source, the 4.0 runtime (with the 4.0 context compiler run unchanged),
and the 5.0 tools. Ground truth comes from the definitions or plain reads,
never from the tools measured.

| Question | Read the source | 4.0 runtime | 5.0 tools |
|---|---|---|---|
| Why is the viewer not returned `maintenanceStatus`? | 4 files, 5,109 tokens | partly, 3 calls, 621 tokens | 1 call, 840 tokens |
| What in the application and workflows rests on `maintenanceStatus`? | 2 files, 3,585 tokens | no answer | 1 call, 1,683 tokens, all 5 found |
| A shipment's destination Site: which system, and does it resolve? | 1 file, 3,221 tokens | 3 calls per object | 1 call for every link, 390 tokens |
| An appointment shows no patient: missing, refused or never linked? | no answer | no answer | 1 call, 212 tokens |

Of six changes to the Air Force model, the contract diff found the two
that change the contract and none of the four that change who may read
what. Two of those four hand the viewer a value a policy or marking was
written to withhold. Change impact reported all six correctly, with no
false positive on a version bump that changes nothing.

The results are not all positive. Context selection was no better than
4.0's: both compilers chose the same Types for four new requirements,
including one worded to share no vocabulary with the model, and both
include Types a correct implementation does not need. The 5.0 context is
1.5 times the size of 4.0's, about 370 tokens more on these requirements,
for the marks, the checks, the consumers and the SDK rules. For a caller
asking about their own access, the 4.0 query plan already says which
values a member policy redacts. The policy itself, its rule and the
remedy come only from an inspector's explanation.

The measurement found a defect, now fixed (ADR-0095). A wildcard mapping
passed every column a source returned straight through, so a value the
model did not declare reached every reader of the object and could be
filtered on. A read now returns only what the model declares.

Time to a correct implementation, human intervention, and whether an
agent uses what the context gives it all need a person or a paid model
run. Neither was done.

### Pressure-tested

An independent adversarial review of the 5.0 work found 17 defects
([`docs/reviews/5-0-pressure-test.md`](docs/reviews/5-0-pressure-test.md)).
The three High ones were all summaries saying more than the decisions
behind them. An impact analysis related a baseline the caller wrote to
the real consumers, so a viewer could ask whether a hidden Action is used.
An inspector explaining someone else was told counts and values they may
not read themselves. A caller's own explanation told a withheld value
from an absent one. All three are fixed, with 12 Medium and Low findings,
one Medium in part and one Low kept with its reason. Explaining someone
else now says, for instance, "2 of the 2 objects you are returned on this
page are returned to the subject", and `not-told` for a value the
inspector may not read. Each fix has a test that failed first and a
mutation that proves the test catches it: 24 new mutations, all killed.

## Build an application from one document

TypeSystem 4.0 adds a semantic application compiler. You, or a coding
agent, describe a whole governed application in one `app.json`: the data
each page reads, the expressions computed from it, the workflows with their
AI steps and approvals, the screens, and the effects buttons have. The
compiler checks that document against the model as each caller would see it,
before any code exists. It then generates an ordinary TypeScript and React
application over the runtime, the workflow engine, the SDK and the HTTP
layer, and verifies it as each caller, through its API and in Chromium.

![Cold Chain Command as the quality assurance pharmacist: four metrics, a live shipment map, the open excursions and a sign-off waiting with the model's recommendation](docs/images/4.0/cold-chain-command-qa.png)

*Cold Chain Command ([`examples/apps/cold-chain`](examples/apps/cold-chain)),
compiled from one `app.json` over three services TypeSystem did not write,
signed in as the quality assurance pharmacist.*

```mermaid
flowchart LR
    spec["app.json<br/>typesys.app/1"] --> check["check<br/>types, references,<br/>policy per caller"]
    check --> compile["compile<br/>src/generated/"]
    ext["src/extensions/<br/>your code"] --> build
    compile --> build["build<br/>tsc + esbuild"]
    build --> verify["verify<br/>API and Chromium,<br/>as each caller"]
```

### One document, five primitives

An application is built from **reads** (an object, a query, an aggregate,
related objects), **expressions** (three-valued: `eq`, `where`, `sum`,
`if`, `hoursSince` and 22 more), **workflow steps** (`read`, `compute`,
`check`, `ai`, `approval`, `action`, `parallel`, `forEach`), **interface
nodes** (`grid`, `metric`, `chart`, `table`, `detail`, `timeline`, `graph`,
`map`, `form`, `approvals`, `run`, `assistant`, `provenance`, `custom` and
more, 19 in all) and
**effects** (`set`, `run`, `invoke`, `navigate`, `refresh`). `typesys app
catalog` prints all of them. This is the Cold Chain workflow that closes a
temperature excursion, abridged:

```json
{
  "name": "coldchain.DispositionExcursion",
  "startPolicy": "coldchain.dispose",
  "input": { "excursionId": { "schema": { "type": "string" }, "objectOf": "coldchain.Excursion" } },
  "steps": [
    { "kind": "read", "name": "excursion", "read": { "kind": "object", "type": "coldchain.Excursion", "id": "$input.excursionId" } },
    { "kind": "compute", "name": "budget", "value": { "fn": "stability#budgetMinutes", "args": { "peakC": "$excursion.peakC" }, "returns": { "type": "number" } } },
    { "kind": "ai", "name": "assess", "model": "stability", "release": "redact",
      "prompt": "Recommend release, quarantine or destroy, how confident you are, and why.",
      "input": { "peakC": "$excursion.peakC", "minutesOut": "$excursion.minutesOut", "budgetMinutes": "$budget", "lots": "$lots" },
      "output": { "type": "object", "properties": { "disposition": { "type": "string", "enum": ["release", "quarantine", "destroy"] } } } },
    { "kind": "approval", "name": "pharmacistSignoff", "policy": "coldchain.qa-release", "present": ["excursion", "assess", "budget", "doses"] },
    { "kind": "action", "name": "close", "action": "CloseExcursion",
      "input": { "excursionId": "$input.excursionId", "disposition": "$assess.disposition" },
      "compensate": { "action": "ReopenExcursion", "input": { "excursionId": "$input.excursionId" } } },
    { "kind": "action", "name": "hold", "when": { "ne": ["$assess.disposition", "release"] },
      "action": "QuarantineShipmentLots", "input": { "shipmentId": "$shipment.$id" } }
  ]
}
```

And a metric on the command page, whose value is computed from two reads:

```json
{ "kind": "metric", "id": "doses-at-risk", "label": "Doses at risk", "format": "integer",
  "value": { "sum": ["$atRisk", "doses"] }, "tone": "warn" }
```

### What the checker catches before any code exists

`typesys app check` types every reference against the model, checks every
policy a step names against the callers that could reach it, and checks the
workflows with the workflow engine's own validator. Every diagnostic points
at the exact JSON field. These are real outputs on Cold Chain with one
mistake seeded in each:

```text
$ typesys app check examples/apps/cold-chain      # a field name misspelt in an AI step's input
  error   unknown-field at /flows/assess/steps/5/input/peakC: $excursion (coldchain.Excursion)
          has no field "peakCelsius" (its fields are $id, shipmentId, logger, startedAt, endedAt,
          peakC, minutesOut, severity, status, disposition, note)

$ typesys app check examples/apps/cold-chain      # a severity compared with a number
  error   not-comparable at /flows/disposition/steps/9/when/gt: one of "minor", "major",
          "critical" cannot be compared with an integer (nothing is converted: compare values
          of one type)

$ typesys app explain not-comparable
not-comparable: Two values of different types are compared, or ordered values are not numbers or dates.
  resolve: Compare values of one type; order only numbers and date-time strings.
```

Nothing is converted silently. A value the caller may be withheld, or that
a skipped step never produced, stays *unknown* through every operator
(Kleene logic), so `count`, `sum` and comparisons never turn a hidden value
into 0 or `false`. On the screen it shows as **Unavailable**, which is what a
carrier's dispatcher sees for the three metrics computed from data they may
not read:

![The same page as a carrier's dispatcher: their own three shipments, three metrics shown as Unavailable, and the open excursions refused](docs/images/4.0/cold-chain-command-carrier.png)

### What is generated, and what you write

`typesys app compile` writes ordinary, readable TypeScript and React into
`src/generated/`: one module per flow (registered with the workflow
engine), one per page, the router, a typed model, typed contracts for your
extensions, and the acceptance tests. The pages are built on
**`@typesys/ui`**: tables (TanStack Table) with sorting, search and filters,
detail panels with a per-value *source* link, charts (Recharts), timelines,
relationship graphs and maps (d3 with offline atlases), forms derived from
the workflow's input schema, approval queues, live run views, an assistant
and provenance. Every component has the loading, empty, error, withheld and
partial states built in, and the design system is separate from the
components, so a deployment can bring its own.

Your code lives in `src/extensions/`, which the compiler writes once and
never again. A `fn` or `custom` node in the spec names an export there, and
the compiler generates its contract, so tsc rejects an extension whose
signature does not match what the spec expects of it:

```ts
// examples/apps/cold-chain/src/extensions/stability.ts
import type { StabilityBudgetMinutes } from "../generated/contracts.js";

export const budgetMinutes: StabilityBudgetMinutes = ({ peakC }) => {
  if (peakC === undefined) return undefined;   // unknown stays unknown
  if (peakC < 0) return 0;                     // frozen spends the whole budget
  ...
};
```

### Safe, incremental regeneration

Generation is deterministic: the same spec and model always produce the
same bytes, and a change rewrites only the files it reaches. A lock file
(`typesys.lock.json`) records the hash of every generated file, so a hand
edit in the wrong place is never lost:

```text
$ typesys app compile examples/apps/cold-chain
  error   edited-generated-file at src/generated/pages/Lots.tsx: src/generated/pages/Lots.tsx
          was edited since it was generated (move the change to app.json or src/extensions/,
          or compile with --force to discard it)
```

### Semantic diff and impact

`typesys app diff` compares two versions of a spec by meaning, not by
text, and says which generated files and which acceptance checks the change
reaches, so an agent can run the right checks first. Here the approval's
policy was changed:

```text
$ typesys app diff examples/apps/cold-chain --against previous/app.json
2 changes
  ~ flow coldchain.DispositionExcursion (steps): its steps changed and its version did not:
    runs in flight resume on the new steps as 1.0.0. Give it a new version
  ~ step disposition/pharmacistSignoff (approval: policy)
Files:
  src/generated/flows/disposition.ts
Checks to run first: logistics-requests-disposition, closed-excursion-refused, auditor-cannot-request,
  qa-signs-off, logistics-cannot-sign-off, qa-sees-command, carrier-sees-only-own,
  excursion-page-offers-assessment
```

### AI steps that only see what their audience may

An `ai` step names a configured model (`typesys.llm.json`, below), and that
model is an *audience* the runtime decides for. The step's input is read
again as the model's audience, so the model is sent only what it may
receive, whoever started the run. In Cold Chain the model never receives a
lot's contract price. Its answer is validated against the step's output
schema, and it is a proposal: the `approval` step that follows shows the
pharmacist the assessment, the budget and the doses, re-read as the
approver so an approver is never shown a value they could not read
themselves, and nothing is written until they approve. If the quarantine
fails after the excursion was closed, the `compensate` Action reopens it.

![Excursion review as the logistics coordinator: the excursion with source links, the stability budget spent, the model's assessment, the disposition waiting on a pharmacist, and the temperature trace](docs/images/4.0/cold-chain-excursion-assessed.png)

### Verified as every caller

Acceptance checks are part of the spec. `reads`, `query` and `refused`
checks say what a caller sees, is withheld or is refused. `offered` checks
say which Actions a caller is offered. `starts` and `approves` checks run a
workflow as one caller and approve it as another. `screen` checks open a page in Chromium as a caller and assert what is
shown, hidden and how many rows a table has. `typesys app
verify` compiles, builds, starts the application with its services and runs
them all:

```json
{ "id": "logistics-lacks-unit-cost", "kind": "reads", "as": "logistics", "type": "coldchain.Lot",
  "objectId": "L-7731", "sees": ["product", "doses"], "withheld": ["unitCost"],
  "because": "unit cost is CONFIDENTIAL and the coordinator is cleared INTERNAL" }
```

### For coding agents

Every stage is a CLI command and the same MCP tool, with the same JSON
diagnostics, so an agent drives the compiler exactly as a person does:

| CLI | MCP tool | What it does |
|---|---|---|
| `typesys app catalog` | `typesys_app_catalog` | Every primitive, operator and scope, and with `--model` the model's Types |
| `typesys app context <dir> --as <caller>` | `typesys_app_context` | The model as that caller may see it, within a token budget |
| `typesys app check <dir>` | `typesys_app_check` | Type and policy check, no code written |
| `typesys app compile <dir>` | `typesys_app_compile` | Generate `src/generated/` |
| `typesys app build <dir>` | `typesys_app_build` | tsc and esbuild |
| `typesys app verify <dir>` | `typesys_app_verify` | Run every acceptance check |
| `typesys app explain <code>` | `typesys_app_explain` | What a diagnostic means and how to resolve it |
| `typesys app diff <dir> --against <app.json>` | `typesys_app_diff` | Semantic diff and impact |
| `typesys app migrate <mission.json> --out <dir>` | `typesys_app_migrate` | Translate a 3.0 mission |

### Migrating a mission

`typesys app migrate` translates a 3.0 mission (`typesys.mission/1`) into
an application and reports what changed. The migrated sortie-readiness
mission passes its 15 original checks unchanged, plus two screen checks,
and gains a form to start its workflow and an approval queue it did not
have:

![The migrated Sortie Readiness app as a planner: fleet and crew tables with a withheld name, the Confirm Sortie form and the approval queue](docs/images/4.0/sortie-migrated-planner.png)

### Cold Chain Command

The reference application ([`examples/apps/cold-chain`](examples/apps/cold-chain),
[ADR-0087](docs/adr/0087-the-reference-application-is-compiled-over-three-services-typesystem-did-not-write.md))
runs over a shipment tracker, a temperature sensor hub and a pharmacy
inventory: three independent services, each with its own data model and
credentials. A logistics coordinator asks for an assessment of a
temperature excursion, a model inside the quality enclave recommends a
disposition, a pharmacist signs it off, and only then is the excursion closed
in the sensor hub and the shipment's lots quarantined in the inventory. Only
quality assurance sees contract prices or the value at risk, an auditor
reads everything else and changes nothing, and a carrier's dispatcher sees
only their own freight.

![A shipment as the pharmacist: details with source links, the temperature trace, the excursion timeline, the relationship graph and the lots on board with unit cost](docs/images/4.0/cold-chain-shipment.png)

It is compiled from one `app.json` (four pages, two workflows) and four
handwritten extensions: the stability rule, the value at risk, a gauge
component and the stand-in model. Those 87 lines are 9.7% of the
application's code by characters. It passes 18 of 18 acceptance checks, 14
through the API and 4 in Chromium, and its browser test drives the whole
path from assessment to quarantine. The model in the example is a
deterministic stand-in, so the example runs without a provider; pointing
`typesys.llm.json` at a real model is a configuration change.

```bash
npx typesys app verify examples/apps/cold-chain   # compile, build, run all 18 checks
cd examples/apps/cold-chain && node dist/server.js # http://127.0.0.1:4700, sign in with demo-qa-token
```

### Measured

[`docs/evidence/compiler-productivity-2026-10-17.md`](docs/evidence/compiler-productivity-2026-10-17.md)
compares the compiler with the 3.0 engineering loop on the same mission,
and every figure there was measured by a script in the repository.

| | 3.0 engineering loop | 4.0 compiler |
|---|---|---|
| Acceptance checks on sortie-readiness | 15 of 15 | 15 of 15 (plus 2 screen checks after migration) |
| Generated code, non-whitespace characters | 9,559 | 10,102 |
| Seeded defects reported before any code exists | 4 of 10, at the step | **5 of 10, at the exact field, in under 200 ms** |
| Further defects warned about before running | 0 | 2 (misspelt policies) |
| A string compared with a number | found by an acceptance check after a 4.2 s build and run | refused by the checker in 169 ms |
| A hand edit to a generated file | overwritten | refused |
| Step kinds available | 4 | 8, including `ai`, `compute` and `parallel` |
| Interface node kinds | tables | 19 |

On a mission both can express, the compiler is about the same size and not
faster to write. It moves type and reference errors in front of the build,
protects work, and expresses applications a mission cannot, such as Cold
Chain. Three of the ten defects (a withheld value, a self-approval and a
mistake in a check itself) are found only by acceptance checks in either
pipeline, which is why checks stay part of the spec.

[ADR-0079](docs/adr/0079-an-application-is-compiled-from-a-typed-ir-of-five-primitives.md)
to [ADR-0087](docs/adr/0087-the-reference-application-is-compiled-over-three-services-typesystem-did-not-write.md)
record the design, [`docs/roadmap-4.md`](docs/roadmap-4.md) the slices, and
[`docs/reviews/4-0-pressure-test.md`](docs/reviews/4-0-pressure-test.md)
the adversarial review (26 findings, all four High fixed, each fix with a
test that failed first and a mutation that proves the test catches it).

## Models, onboarding and drafting

TypeSystem talks to language models through **`@typesys/llm`**, which is
provider-agnostic. Models are configured capabilities behind two protocols:
Anthropic Messages, and OpenAI Chat Completions for OpenAI, OpenRouter,
Ollama, LM Studio, vLLM and any compatible server
([ADR-0074](docs/adr/0074-models-are-configured-capabilities-behind-two-protocols.md)).
A request says what it needs (structured output, tools, streaming, a context
size), and a model that cannot meet it is refused before anything is sent.
Structured answers are validated against their JSON Schema whatever the
provider claims. Configuration is one versioned file with credentials named
by environment variable, never stored:

```json
{
  "format": "typesys.llm/1",
  "providers": { "qa-enclave": { "kind": "custom", "environment": "private" } },
  "models": {
    "stability": { "provider": "qa-enclave", "model": "stability-standin", "uses": ["runtime"],
                   "audience": { "id": "model:coldchain-enclave/stability", "roles": ["coldchain-model"], "clearance": "INTERNAL" } }
  }
}
```

Each model is an **audience**: the runtime decides what it may receive as it
decides for a person, and a fallback to another model is a new release
decision, never a silent reroute. A local model failing never sends
unlabeled content to a hosted provider
([ADR-0075](docs/adr/0075-a-model-receives-only-what-its-audience-may.md)).

Three tools are built on it. **Onboarding** (`typesys onboard`,
[ADR-0076](docs/adr/0076-onboarding-proposes-from-evidence-and-an-expert-approves.md))
reads the metadata of existing sources (PostgreSQL catalogs, OpenAPI
documents, JSON Schemas, never a row), proposes a governed model in which
every item cites the evidence it rests on, lets a model refine it under
checks, and leaves the policy rules for an expert to write. **Drafting**
(`typesys engineer draft`,
[ADR-0077](docs/adr/0077-a-mission-is-drafted-from-words-and-typesystem-decides.md))
turns a person's brief into a mission spec, with the brief owning
everything that grants authority and every answer checked by the same
planner as a hand-written spec. In agent mode, with the coding agent as the
drafting model, the three evaluation tasks were drafted in one round each and
passed 43 of 43 hidden checks
([evidence](docs/evidence/llm-drafting-2026-10-16.md)). The **context
compiler** (`compileContext`, MCP `typesys_compile_context`,
[ADR-0078](docs/adr/0078-a-coding-agent-is-given-the-model-its-caller-may-see.md))
gives a coding agent the model as its caller may see it, ranked by the task
and within a token budget, marking values the caller is not returned.


## Where it sits in a system

```mermaid
flowchart TB
    subgraph callers["Callers"]
        web["Web or mobile app<br/>(@typesys/sdk, @typesys/react)"]
        svc["Other services<br/>(REST: @typesys/http)"]
        agent["AI agent<br/>(MCP: @typesys/mcp-server)"]
        wf["Long-running processes<br/>(@typesys/workflow)"]
    end
    subgraph ts["TypeSys process"]
        rt["SemanticRuntime<br/>getObject · query · aggregate · invokeAction"]
        reg["Registry: Types, relationships,<br/>Actions, data sources, mappings"]
        pol["Policy engine (ABAC or Cedar)<br/>+ classification"]
    end
    subgraph stores["Systems of record (unchanged)"]
        pg[("PostgreSQL")]
        rest[("Existing REST API")]
        http[("Other HTTP services")]
        mem[("In-memory / your own adapter")]
    end
    meta[("PostgreSQL: registry tables,<br/>audit_events, workflow journal")]
    web --> rt
    svc --> rt
    agent --> rt
    wf --> rt
    rt --- reg
    rt --- pol
    rt -->|adapter| pg
    rt -->|adapter| rest
    rt -->|adapter| http
    rt -->|adapter| mem
    reg --- meta
```

TypeSys does not replace your databases. Your systems of record stay where
they are; TypeSys reads from them (and writes to them through Actions) on every
request. What it stores itself is the model, the mappings and the audit log.
Two optional parts also hold copies of business data, which matters if you are
deciding data residency or accreditation: the Redis cache (when you enable it)
keeps adapter output and computed values as plaintext JSON until they expire,
and the workflow journal keeps each step's inputs and outputs for as long as
the run's history is kept.

You run it either as a library inside your Node service
(`new SemanticRuntime(...)`) or as a server that exposes it over REST
(`createApiApp`) and MCP (`npm run mcp:http`). Callers never get a database
connection.

## What a read returns

The airforce example domain spreads one aircraft across two systems: its own
fields live in a fleet repository, and its maintenance history lives in a
separate maintenance system reached over REST. Reading tail number
`AF86-0147`:

```ts
const aircraft = await runtime.getObject("airforce.Aircraft", "AF86-0147", maintainer, { includeProvenance: true });
```

As the maintainer (role `maintainer`, cleared SECRET):

```json
{
  "id": "AF86-0147", "tailNumber": "AF86-0147", "model": "F-16C",
  "maintenanceStatus": "degraded",
  "deploymentLocation": "FOB ALPHA (exercise designation)",
  "readinessStatus": "PMC",
  "needsAttention": true,
  "...": "..."
}
```

As the viewer (role `viewer`, cleared CUI), the same call returns the same
object without `maintenanceStatus` (a property policy allows it to maintainers
only), without `readinessStatus` (computed from `maintenanceStatus`, so it
inherits that restriction), and without `deploymentLocation` (marked SECRET).
`needsAttention` stays, because the model explicitly releases that one yes/no
flag to every reader. Anonymous callers get `Not authorized: read
airforce.Aircraft/AF86-0147`.

With `includeProvenance`, each value carries where it came from:

```json
{ "propertyPath": "maintenanceStatus",
  "source": { "dataSourceId": "in-memory-airforce-repo", "system": "airforce-repo", "recordId": "AF86-0147", "field": "maintenanceStatus" },
  "retrievedAt": "2026-10-14T09:05:57.987Z", "confidence": 1 }
```

`needsAttention` is a computed property. Its code reads `maintenanceStatus`
and, if that alone doesn't decide it, asks the maintenance system for open
work orders against this aircraft. `getProvenance` traces it back to the
values it was derived from.

The model that produces this is ordinary JSON Schema with a few annotations
([`packages/domain-airforce/src/types/aircraft.ts`](packages/domain-airforce/src/types/aircraft.ts)):

```ts
properties: { tailNumber: { type: "string" }, model: { type: "string" }, deploymentLocation: { type: "string" } },
"x-relationships": {
  components:  { target: "airforce.Component",        cardinality: "one-to-many",
                 resolution: { dataSourceId: "in-memory-airforce-repo", operation: "byForeignKey:aircraftId" } },
  maintenance: { target: "airforce.MaintenanceEvent", cardinality: "one-to-many",
                 resolution: { dataSourceId: "mock-remis-rest",       operation: "byForeignKey:aircraftId" } }
},
"x-computed": { needsAttention: { dependsOn: ["maintenanceStatus"], releases: ["maintenanceStatus"],
                                  binding: "computeNeedsAttention", schema: { type: "boolean" } } },
"x-policy":   { objectPolicy: "airforce.read-aircraft", propertyPolicies: { maintenanceStatus: "airforce.maintainer-only" } },
"x-provenance": { properties: { deploymentLocation: { classification: "SECRET" } } }
```

## How data is stored and loaded

### What lives where

| Data | Where it lives | Package |
|---|---|---|
| Your business data | In your existing systems, reached through an **adapter** per system | `adapter-postgres`, `adapter-http`, `adapter-mock-rest`, `adapter-in-memory`, or your own |
| The model: Types, relationships, Actions, data sources, mappings | Registry tables `types`, `relationships`, `actions`, `data_sources`, `mappings` | `registry-store-postgres` (or in memory for tests) |
| The audit log | Table `audit_events`; update and delete are blocked by a trigger | `registry-store-postgres` |
| Workflow runs, approvals and timers, including each step's inputs and outputs | Tables `typesys_workflow_runs` and `typesys_workflow_events`; events are append-only, enforced by triggers | `workflow-postgres` |
| Optional cache and rate limits shared across instances; the cache holds copies of adapter output and computed values until they expire | Redis | `redis` |

An **adapter** is the only code that talks to a store. It implements one
small interface ([`packages/core/src/runtime/adapter.ts`](packages/core/src/runtime/adapter.ts)):

```ts
interface Adapter {
  readonly dataSourceId: string;
  resolveProperties(typeName, objectId, propertyNames): Promise<{ values, provenance }>;
  queryByType(typeName, filter?, limit?, cursor?, sort?): Promise<{ items, nextCursor? }>;
  resolveRelationship(relationship, sourceObjectId): Promise<{ objectId }[]>;
  executeAction(action, input, ctx): Promise<unknown>;
  aggregate?(query): Promise<AggregateResult>;          // optional
  canFilter?(typeName, property, operator): boolean;    // optional: what it can filter in the store
}
```

A **mapping** connects a Type to an adapter. `targetName: "*"` means "all of
this Type's properties come from this data source"; a mapping for one property
overrides it, so one object can be assembled from several stores.

### The Postgres adapter's storage

`@typesys/adapter-postgres` is generic: it keeps every object of every Type
as one JSON row, so a new Type needs no migration.

```sql
CREATE TABLE objects (
  type_name  TEXT NOT NULL,
  object_id  TEXT NOT NULL,
  values     JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (type_name, object_id)
);
CREATE INDEX idx_objects_values ON objects USING GIN (values);
```

Loading one object is `SELECT values FROM objects WHERE type_name = $1 AND
object_id = $2`. A query's filter is compiled to a parameterized `WHERE` over
the JSONB column, using the GIN index for equality, and every row that comes
back is checked again in TypeScript, so a filter SQL can only approximate
never lets through a row it shouldn't. A relationship such as
`byForeignKey:aircraftId` becomes `WHERE type_name = $1 AND values @> '{"aircraftId": "AF86-0147"}'`,
a containment test the same GIN index serves.

For a high-volume Type with its own table and columns, write an adapter for
that table; nothing above the adapter changes. To put a TypeSys model over an
existing service you don't own, `@typesys/adapter-http` maps JSON fields to
properties with JSON Pointers and supports API keys and OAuth client
credentials.

### The read path

What `runtime.getObject(type, id, identity)` does, in order
([`packages/core/src/runtime/runtime.ts`](packages/core/src/runtime/runtime.ts)):

1. Check the caller's rate limit, and that their clearance covers the
   Type's markings.
2. Find the Type's mappings and call each adapter's `resolveProperties`
   (concurrently, under a per-request concurrency budget, with a timeout,
   retries and a circuit breaker per call). Per-property overrides from other
   stores are merged in.
3. Decide the Type's object policy on the stored values. This is how
   row-level rules work: "a clinician reads only patients assigned to them"
   is decided on each record's own fields.
4. Run the Type's computed properties, each over only the inputs its
   `dependsOn` names.
5. Remove properties whose classification is above the caller's clearance,
   then properties whose own policy refuses this caller. A computed value goes
   too when any input it was derived from is withheld, unless the model
   `releases` that input for it.
6. Attach provenance if asked (a computed value's provenance names its inputs
   and every system its code consulted), write the audit rows, and return.

`runtime.query` does the same for many objects. Before reading, it turns the
caller's read policy into a filter and pushes it into the adapter's query
where the adapter says it can evaluate that filter exactly, so Postgres never
returns rows the caller could not read anyway. Every returned object is still
decided on its own data.

### The write path

Callers never write to a store directly. They invoke an **Action**, a named
operation with an input schema, a permission rule, optional preconditions and
a declared side effect. `runtime.invokeAction(name, input, identity)`:

1. checks the Action's permission rule, on the target object's own data when
   the Action acts on one object (a refusal is audited);
2. validates the input against its JSON Schema;
3. runs each precondition (for example "a closed work order cannot change
   status");
4. calls `executeAction` on the adapter named in the Action's
   `implementation`, which performs the write in the store;
5. evicts the target from the cache and, when the Action is marked
   `auditRequired`, writes a success row to the audit log.

The generic Postgres, HTTP and in-memory adapters implement no Actions: what a
write means is specific to your data, so you write that part. The example
below does it in a dozen lines. `PostgresRepositoryAdapter.put()` exists for
loading data and for your Action code to call; it is not exposed to callers.

## A complete example on PostgreSQL

A `fleet.Truck` Type stored in Postgres, readable by dispatchers and
mechanics, whose `driverNotes` only mechanics see, and whose status only a
mechanic may change. This was run against PostgreSQL 16 while writing this
README.

```ts
import { buildRuntime, requireRole, type ActionDefinition, type Identity } from "@typesys/core";
import { createPool, runMigrations as migrateRegistry, PostgresRegistryStore } from "@typesys/registry-store-postgres";
import { runMigrations as migrateObjects, PostgresRepositoryAdapter } from "@typesys/adapter-postgres";
import { createApiApp } from "@typesys/http";

const pool = createPool();          // DATABASE_URL
await migrateRegistry(pool);        // model tables + audit_events
await migrateObjects(pool);         // objects table

// Reads come from the generic adapter. Writes are yours: an Action names an
// operation, and the adapter for its data source carries it out.
class FleetStore extends PostgresRepositoryAdapter {
  override async executeAction(action: ActionDefinition, input: unknown): Promise<unknown> {
    if (action.implementation.operation !== "setStatus") throw new Error(`no operation ${action.implementation.operation}`);
    const { truckId, status } = input as { truckId: string; status: string };
    const { values } = await this.resolveProperties("fleet.Truck", truckId, []);
    const next = { ...values, status };
    await this.put("fleet.Truck", truckId, next);
    return next;
  }
}
const fleet = new FleetStore(pool, "fleet-db", "Fleet database");
await fleet.put("fleet.Truck", "T-100", { id: "T-100", plate: "7ABC123", status: "in-service", driverNotes: "brakes soft" });

const { registry, runtime } = await buildRuntime({
  store: new PostgresRegistryStore(pool),
  manifests: [],
  adapters: [fleet],
  policyRules: {
    "fleet.staff": requireRole("dispatcher", "mechanic"),
    "fleet.mechanic": requireRole("mechanic")
  }
});

await registry.registerDataSource({ id: "fleet-db", name: "Fleet database", kind: "postgres" });
await registry.registerType(
  {
    $id: "https://example.com/types/fleet/Truck/1.0.0",
    title: "Truck",
    type: "object",
    properties: { id: { type: "string" }, plate: { type: "string" }, status: { type: "string" }, driverNotes: { type: "string" } },
    "x-policy": { objectPolicy: "fleet.staff", propertyPolicies: { driverNotes: "fleet.mechanic" } }
  },
  { name: "fleet.Truck", version: "1.0.0" }
);
await registry.registerMapping({
  id: "map-truck", typeName: "fleet.Truck", target: "property", targetName: "*",
  dataSourceId: "fleet-db", operation: "get", resolutionMode: "live"
});
await registry.registerAction({
  id: "action-set-truck-status", name: "SetTruckStatus", version: "1.0.0",
  description: "Take a truck in or out of service.",
  applicableTypes: ["fleet.Truck"], target: { idFrom: "truckId" },
  inputSchema: {
    type: "object",
    properties: { truckId: { type: "string" }, status: { enum: ["in-service", "out-of-service"] } },
    required: ["truckId", "status"], additionalProperties: false
  },
  outputSchema: { type: "object" },
  authorizationPolicy: "fleet.mechanic",
  implementation: { dataSourceId: "fleet-db", operation: "setStatus" },
  sideEffects: "mutates", idempotency: "natural", auditRequired: true
});

const dispatcher: Identity = { subjectId: "dana", roles: ["dispatcher"], attributes: {} };
const mechanic: Identity = { subjectId: "mo", roles: ["mechanic"], attributes: {} };

await runtime.getObject("fleet.Truck", "T-100", dispatcher);
// { typeName: "fleet.Truck", objectId: "T-100",
//   values: { id: "T-100", plate: "7ABC123", status: "in-service" } }   driverNotes withheld

await runtime.invokeAction("SetTruckStatus", { truckId: "T-100", status: "out-of-service" }, mechanic);
try {
  await runtime.invokeAction("SetTruckStatus", { truckId: "T-100", status: "in-service" }, dispatcher);
} catch (err) {
  console.log(String(err)); // AuthorizationError: Not authorized: invoke fleet.Truck/SetTruckStatus
}

const tokens: Record<string, Identity> = { "dana-token": dispatcher, "mo-token": mechanic };
createApiApp({
  backend: { registry, runtime },
  identityResolver: async (token) => tokens[token ?? ""] ?? { subjectId: "anonymous", roles: [], attributes: {} }
}).listen(8080);
```

Afterwards the database holds the model in the registry tables, one row in
`objects` with `status: "out-of-service"`, and in `audit_events` a row for
each decision: Dana's read, Mo's allowed `SetTruckStatus` and its success, and
Dana's refused `SetTruckStatus`. `curl -H "Authorization: Bearer mo-token"
localhost:8080/api/objects/fleet.Truck/T-100` returns the truck with
`driverNotes`; with `dana-token` it returns it without.

In production the identity resolver is `createOidcIdentityResolver` from
`@typesys/auth-oidc`, which verifies a JWT against your identity provider. The
API never assumes an identity of its own.

## What callers use

| Caller | Package | What it gets |
|---|---|---|
| TypeScript code in the same process | `@typesys/core` | `getObject`, `query`, `aggregate`, `getProvenance`, `listActions`, `previewAction`, `invokeAction`, `describeModel` |
| A typed client | `@typesys/sdk` | `af.from("airforce.Aircraft").where((a) => a.needsAttention.eq(true)).page()`, checked by the compiler, over the runtime, REST or MCP |
| A React app | `@typesys/react` | Hooks over the SDK; form fields and table columns derived from the model |
| Any HTTP client | `@typesys/http` | `GET /api/objects/:type/:id`, `POST /api/query`, `POST /api/actions/:name/invoke`, workflow routes, an OpenAPI document; errors as RFC 9457 problems |
| An AI agent | `@typesys/mcp-server` | MCP tools `typesys_discover`, `typesys_get_object`, `typesys_query`, `typesys_get_provenance`, `typesys_list_actions`, `typesys_preview_action`, `typesys_invoke_action` and others, plus one tool per Action the caller may invoke |
| A multi-step process with approvals | `@typesys/workflow` | Steps that read, compute, ask a model, wait for a person's approval and invoke Actions, each as the person who started it; the journal survives restarts |
| A whole application, from a spec | `@typesys/compiler`, `@typesys/ui`, `@typesys/app` | `typesys app check, compile, build, verify, diff, migrate` and the same nine `typesys_app_*` MCP tools: an `app.json` type-checked against the model, compiled to TypeScript and React, and verified as each caller ([above](#build-an-application-from-one-document)) |
| A language model | `@typesys/llm` | Anthropic Messages or OpenAI-compatible models (OpenAI, OpenRouter, Ollama, LM Studio, vLLM) as configured capabilities, each an audience the runtime decides for ([above](#models-onboarding-and-drafting)) |
| A coding agent | `@typesys/mcp-server`, `@typesys/compiler` | `typesys_compile_context` (the part of the model a requirement needs, each value marked verified, withheld, inferred or unavailable, with the checks to keep passing), `typesys_explain`, `typesys_inspect`, `typesys_graph`, `typesys_impact`, the `typesys_app_*` tools, `typesys onboard` and `typesys engineer draft` ([above](#understand-an-unfamiliar-system)) |

An agent connected over MCP is just another caller with an identity. It sees
only what that identity may see and can change only what that identity may
change. A model can also be given an *audience* of its own, so policy can
decide what may be sent to that model regardless of who is asking
([ADR-0067](docs/adr/0067-release-to-models-is-decided-for-the-model.md)).

## Why use it

- **The rules are written once.** Without it, every application and every
  agent integration re-implements "who may see this field" and drifts. Here
  the rule lives in the model and the runtime enforces it for every caller.
- **One object across several systems.** An aircraft whose data is split
  between a fleet database and a maintenance system is read as one object,
  without building a data warehouse or a sync job.
- **Agents get governed access, not credentials.** An agent never holds a
  database password or an API key to a back-end system. It holds a token for
  a person or a model audience, and everything it does is audited under that.
- **Every value can be traced.** Provenance says which system and record a
  value came from, which matters when a decision is questioned later.
- **Every decision can be explained, and every change weighed first.** A
  developer the deployment admits can ask why someone was refused or
  returned less, and get the runtime's own answer with the rule and the
  remedy. Before a change ships, they can see who would newly read what,
  and which checks to run.
- **Applications are checked before they exist.** An application compiled
  from an `app.json` is type-checked against the model and the policies of
  each caller before any code is written, and verified as every caller
  afterwards.
- **Writes are explicit.** The only changes possible are the Actions in the
  model, each with a permission check, input validation and preconditions.

**When not to use it:** one application over one database, with simple access
rules. TypeSys adds a layer, a model to maintain and a few milliseconds per
request; it pays for itself when several systems, several kinds of caller, or
per-record and per-field rules are involved.
[`docs/why-typesys.md`](docs/why-typesys.md) goes through the trade-offs.

## Try it

```bash
npm install
npm run build
npm run demo          # http://localhost:4000: two domains, switch identity and policy engine
npm run mcp:http      # MCP at http://localhost:3939/mcp, Authorization: Bearer demo-maintainer-token
npm run studio        # http://localhost:4400: the semantic workbench: model, explain, graph, impact
npm run impact:demo   # what releasing readinessStatus to viewers would expose
npx typesys app verify examples/apps/cold-chain   # compile, build and run Cold Chain's 18 checks
npm run draft:demo    # draft a mission from a brief and verify it (10 checks)
```

With PostgreSQL available:

```bash
export DATABASE_URL=postgresql://user:pass@localhost:5432/typesys
npm run migrate:postgres     # registry tables, audit_events, objects
npm test                     # Postgres-backed tests run only when DATABASE_URL is set
npm run onboard:demo         # propose a governed model from a database's catalog
```

Other commands: `npx tsx scripts/measure-workbench.ts` (the 5.0 measurement), `npm run lint`, `npm run typecheck`,
`npm run check:terminology`, `npm run smoke:mcp`, `npm run benchmark`,
`npm run load-test`, `npm run mutation` (deliberately breaks security checks
and confirms a test fails for each), and `npm run mission` (the same
squadron readiness app built with and without TypeSys).

## Packages

| Group | Packages |
|---|---|
| Runtime | `core` (model, registry, runtime, ABAC policy, audit), `policy-cedar` (Cedar policy engine) |
| Storage and sources | `adapter-postgres`, `adapter-http`, `adapter-mock-rest`, `adapter-in-memory`, `registry-store-postgres`, `workflow-postgres`, `redis` |
| Security | `auth-oidc` (JWT identity), `encryption` (field encryption at rest with blind indexes for equality), `kms-aws` (KMS-wrapped keys) |
| Access surfaces | `http` (REST API), `mcp-server`, `sdk`, `react`, `workflow` |
| Applications | `compiler` (the `typesys.app/1` checker, code generator, verifier, semantic diff and mission migration), `ui` (React components for tables, detail, charts, timelines, graphs, maps, forms, approvals, runs, an assistant and provenance, with a separate design system), `app` (three-valued expressions, flow helpers and the server compiled applications run on) |
| Models and agents | `llm` (provider-agnostic models behind two protocols, release to model audiences), `onboard` (a governed model proposed from source metadata), `engineer` (missions drafted, scaffolded and verified) |
| Tooling | `cli` (YAML authoring, code generation, and the `typesys app`, `onboard` and `engineer` commands), `devkit` (discovery, query validation, contract diff, the dependency graph, task-aware context, change impact and link probes), `packs` (signed, versioned domain packages), `studio` (the semantic workbench: model, explanations, dependency graph and change impact in a browser) |
| Examples | `domain-airforce`, `domain-hospital`, `demo-web`, `mission-readiness`, `sortie-readiness`, `cold-chain` (with `examples/apps/cold-chain`, an application compiled over three services), `examples/services` (six independent services TypeSys reads over HTTP) |
| Evaluation | `evaluation` (harness comparing building with and without TypeSys, judged by hidden checks) |

## Status

The runtime is tested end to end against real PostgreSQL, Redis and a KMS
emulator, including mutation testing of the security checks and independent
adversarial reviews (in [`docs/reviews/`](docs/reviews/)). Every pull
request runs the full suite. A catalog of 219 deliberate mutations, each
of which a test must catch, runs locally with `npm run mutation`, never
on GitHub for a change. Among them are a compile that overwrites a hand
edit, a lock entry outside the application, and a figure computed from a
failed read shown as known. It has not had an
external security review, validation against a real KMS, or production-scale
load and high-availability testing. No package is published to npm yet.
[`docs/PRODUCTION-READINESS.md`](docs/PRODUCTION-READINESS.md) lists what
remains and [`docs/completeness.md`](docs/completeness.md) what is built.

## Documentation

- [`docs/README.md`](docs/README.md): index of the tutorial, how-to guides,
  reference and decision records.
- [`docs/architecture.md`](docs/architecture.md): the read, query, policy and
  Action paths call by call, with diagrams.
- [`docs/how-to/use-postgres.md`](docs/how-to/use-postgres.md),
  [`write-an-adapter.md`](docs/how-to/write-an-adapter.md),
  [`combine-multiple-sources.md`](docs/how-to/combine-multiple-sources.md),
  [`add-a-relationship-and-action.md`](docs/how-to/add-a-relationship-and-action.md):
  the storage and write paths in more depth.
- [`docs/for-agents.md`](docs/for-agents.md) and [`llms.txt`](llms.txt): for
  building agents against the MCP server.
- [`docs/roadmap-5.md`](docs/roadmap-5.md): the semantic workbench, slice by
  slice; [`docs/roadmap-4.md`](docs/roadmap-4.md): the application compiler;
  and [`docs/evidence/`](docs/evidence/): every measurement.
- [`docs/adr/`](docs/adr/): 95 architecture decision records.

Versioning uses [changesets](https://github.com/changesets/changesets); see
[ADR-0020](docs/adr/0020-publish-infrastructure.md) for publishing.

MIT licensed.
