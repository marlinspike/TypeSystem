# TypeSystem 5.0 pressure test (inspection, explanations, graph, context, impact, links)

Reviewed: `claude/semantic-workbench-f4qk65`, commits ad8ebb0..5d75936
(ADR-0088 to ADR-0095), 2026-10-17. An independent reviewer read the
diff and tried to break it from the outside: as a viewer, a nurse and an
auditor under open and need-to-know discovery, over the runtime, HTTP
and MCP. Every finding below was reproduced with a script before it was
reported, and every fix has a test that fails without it.

**Summary: 17 findings and one known finding. 3 High, 8 Medium, 6 Low.**
15 are fixed, one in part (M2), and one is kept with its reason (L3).
The known finding is fixed, and so is one more defect found while fixing
the others. 24 new mutations guard the fixes, and all are killed.

The common thread was the one ADR-0089 warned about. An explanation, an
impact analysis or a probe runs the runtime's own decisions, but each
summarizes them: a count, a reach, a "no value". A summary can say more
than the decisions it summarizes. Most fixes make the summary say only
what the investigator's own reads would.

## High

### H1. A forged baseline told a non-inspector which hidden names the consumers use. Fixed.

`POST /impact` and `typesys_impact` related each change to what uses it
in graphs built from both baselines, including the one the caller sent,
keeping consumers' uses of names neither described. Under need-to-know,
a viewer added `CreateMaintenanceWorkOrder` and `deploymentLocation` to
their own baseline and was told that GroundForRepair and the board use
them, while a guessed name reached nothing. With a forged inspection the
same worked for policy names. This contradicted ADR-0093's claim that a
forged baseline can only mislead its sender.

**Fix:** `governedImpact` (`packages/devkit/src/impact.ts`), used by both
hosts, finds what a change reaches only in the caller's own governed
graph unless they may inspect. A name the caller adds is compared and
echoed back, never related to anything. **Test:**
`packages/http/test/workbench.test.ts`, "relates a name a caller adds to
their baseline to nothing that uses it". **Mutation:**
`impact.forged-baseline-graph`.

### H2. Explaining someone else disclosed counts and values the inspector could not read. Fixed.

An auditor who may read one patient explained a query as the admin and
was told "3 objects returned"; a relationship gave `count: 3`; a read of
P1 said the SECRET `location` and the guarded `ssn` were returned,
though the auditor's own read leaves both out.

**Fix:** counts are taken among the objects the investigator is returned
themselves ("2 of the 2 objects you are returned on this page are
returned to the subject"). A value the investigator may not read is
reported as `not-told`. **Tests:**
`packages/domain-hospital/test/explain-disclosure.test.ts`, first two
cases. **Mutations:** `explain.counts-not-intersected`,
`explain.not-told-dropped`.

### H3. A caller's own explanation told a withheld value from an absent one. Fixed.

A member policy and a marking were decided only when the object held a
value. A nurse explaining her own read got `no-value` on a patient with
no SSN and `withheld` on one with an SSN, while `getObject` returned the
same for both. Baseline probes carried the same oracle.

**Fix:** while explaining, every declared value's marking and policy is
decided whether or not it is present (`finalizeValues`,
`classifiedOut`). **Test:** "explains a withheld value as withheld
whether or not the object holds one", for a policy and a marking.
**Mutations:** `explain.withheld-presence`,
`explain.policy-withheld-presence`.

## Medium

### M1. Recorded decisions named values the investigator's discovery withholds. Fixed.

`observed` audit rows passed `propertyPath` through, so a need-to-know
auditor whose own description omits `ssn` saw it named. **Fix:** rows
are kept only for values and objects the investigator is told of.
**Test:** "lists no observed decision about a value its discovery
withholds". **Mutation:** `explain.observed-unfiltered`.

### M2. Workflow explanations named hidden Actions, gave raw reasons, and were not audited. Fixed in part.

**Fix:** a caller is told "the Action this step invokes is not described
to you" and only an inspector the name; a caller under need-to-know gets
"Not authorized", as the runtime would tell them; every attempt is
audited as `workflow.explain` with its subject, refused or answered.
**Test:** `packages/workflow/test/explain.test.ts`, "WorkflowEngine.explain
under need-to-know". **Mutations:** `workflow.explain-names-action`,
`workflow.explain-raw-reason`, `workflow.explain-unaudited`.
**Not fixed:** the subject's description and Actions, read to answer an
inspector's question, are still audited as the subject's own decisions
without `explainedBy`. The runtime has no public way to mark them, and
ADR-0089's amendment says so.

### M3. Context marked withheld values as verified readable. Fixed by H3.

The context compiler explains the first probed object; with H3 its
withheld values are reported `withheld` with their control. Rerunning the
reviewer's script gives `ssn: withheld (member-policy)` and `location:
withheld (classification)`. Guarded by the H3 test and mutations.

### M4. Impact missed computed inputs, relationship markings and withheld markings. Fixed.

Making `readinessStatus` depend on nothing and marking the `maintenance`
relationship SECRET came back `compatible` with no items. **Fix:**
`diffGovernance` compares a computed value's inputs (added narrows,
removed widens), relationship markings, and the count of markings the
recorder may not learn of. The reviewer's script now reports both
changes, verdict `risky`. **Test:** `packages/devkit/test/impact.test.ts`,
"an input added to a computed value narrows it". **Mutations:**
`impact.dependency-uncompared`, `impact.relationship-markings-uncompared`,
`impact.withheld-markings-uncompared`.

### M5. A source outage while recording a baseline produced false exposures. Fixed.

**Fix:** a read a source could not answer, before or after, is reported
as "not compared: a source was unavailable" instead of as values newly
returned, and an explanation that failed is recorded `unavailable`, not
`refused`. **Test:** "compares no read a source could not answer".
**Mutation:** `impact.outage-compared`.

### M6. A computed value depending on an undeclared value crashed the graph. Fixed.

The registry accepted any `dependsOn`, and the overview and dependency
views threw on the edge to a node that did not exist (HTTP 500). **Fix:**
the registry refuses a dependency on anything but a declared or computed
value, and the graph leaves out edges to nothing, which also covers an
input withheld from the caller. **Tests:**
`packages/core/test/declared-values.test.ts`,
`packages/devkit/test/graph.test.ts`. **Mutations:**
`registry.undeclared-dependency`, `graph.edge-to-nothing`.

### M7. The graph missed what a read step reaches through a relationship. Fixed.

GroundForRepair's `history` step followed `maintenance` to
MaintenanceEvent while declaring only Aircraft, so a change to an
event's values reached nothing. **Fix:** a read step that follows a
relationship, through `related` or an `include`, must declare the target
Type, and the engine refuses the read otherwise; `history` now declares
both. A part that reads two related Types is related to the relationship
between them. **Tests:** "fails a read step that follows a relationship
to a Type it does not declare" and "relates a step that reads two related
Types to the relationship between them". **Mutations:**
`workflow.followed-undeclared`, `graph.followed-relationship-unrelated`.

### M8. Dangling references went uncounted under an attribute policy. Fixed.

An investigator's own policy was decided on the missing object's empty
attributes and denied, so the reference was skipped. **Fix:** whether the
object exists is asked of its source first. **Test:** "names a dangling
reference although its own policy decides on values the missing object
does not have".

## Low

| | Finding | Status | Test |
|---|---|---|---|
| L1 | A query explanation charged the investigator's rate limit twice | Fixed | "is charged to the investigator once"; mutation `explain.charged-twice` |
| L2 | A refused explanation was not audited | Fixed | "is audited with the subject it was about, when it is refused too"; mutation `explain.refusal-unaudited` |
| L3 | A subject's own link probe counts all-refused relationships as empty | Kept, documented | ADR-0094 and the `empty` field now say that in a subject's own probe, empty means nothing was returned to them: telling them an object was refused would say it exists |
| L4 | Malformed `/explain` questions and nested baseline shapes gave HTTP 500 | Fixed | "refuses a malformed question as invalid input", "is checked before it is compared"; mutations `explain.malformed-question`, `impact.malformed-inspection-accepted` |
| L5 | Probe values were looked up through the prototype chain | Fixed | "compares only the values a probe records"; mutation `impact.prototype-values` |
| L6 | The evaluation claimed the source-id leak was fixed, and that C's output leaked nothing | Fixed | The evidence page now says what was found and fixed |

## The known finding

`explainQuery` named the scan step's `dataSourceId` to a caller who may
not inspect. **Fixed:** a non-inspector is shown `(withheld)`. **Test:**
"names the sources only to an inspector". **Mutation:**
`explain.plan-sources-named`.

## Found while fixing

### A `byOwnField` link told whoever followed it the field's value. Fixed.

The reviewer noted it as unverified. A `byOwnField` relationship's target
is the object the source's own field names, so a nurse refused `bedId`
could follow `bed` and read the bed's id. It shipped in this branch
(ADR-0094). **Fix:** following a `byOwnField` or `byCompositeKey`
relationship is decided as each source field it names is, in a read and
in an include. **Test:** "is refused to a reader the value is withheld
from, since its target names the value". **Mutation:**
`runtime.own-field-link-undecided`.

## Not reported as defects

- Under need-to-know, consumer and part names (step names such as
  `openWorkOrder`) are shown in the graph to callers who may not learn of
  the Actions those steps invoke. The names are the application's, not
  the model's, which ADR-0090 accepts.
- MCP `typesys_graph` does not range-check `depth` or `limit`. Walks are
  bounded by the graph's size.
