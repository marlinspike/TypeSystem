# 0049. A Query the Caller Can Read None Of Is Refused

## Status

Accepted — implemented in `@typesys/core` (`query` in `runtime/runtime.ts`).
Amends three earlier decisions, each of which chose an empty page for this
case: ADR-0030 (consequences: "an anonymous query of a guarded Type is an
empty page, not a 403"), ADR-0032 (§3: a classified Type's `query` returns
an empty page), and ADR-0038 (§7: a `never` plan returns an empty page).
Proven by:

- `packages/core/test/query-wholesale-denial.test.ts` — both wholesale
  denials refuse without calling the adapter and audit one deny; every
  data-dependent denial is still a silent page; and an attack block showing
  the refusal cannot be used to find out whether hidden rows exist.
- The suites that asserted the old empty page, updated to assert the
  refusal: row-level authorization, authorization planning, data
  classification, the MCP server's classification suite, and the
  Cedar/ABAC parity suite.

Mutation-checked (8 mutations): a classified Type answered with an empty page
again, a `never` plan answered with one, two over-reaches that would make the
refusal an existence oracle (refusing any empty page, and refusing an exact
predicate plan), the refusal thrown before it is audited, audited twice,
echoing a caller attribute in its reason, and a rule that can't plan refused
when it denies a row — each fails the suites.

## Context

A caller who can read nothing of a Type got `{ items: [] }`, the same answer
as a caller of a Type with no rows. Every other read path already refuses:
`getObject`, `getRelationship`, `getProvenance`, `aggregate` and
`invokeAction` throw `AuthorizationError`. For a web API that is a 200 where
a 403 belongs. For an AI agent it is worse: an empty result reads as "there
are no vehicles", and the agent reports that to a user, when the truth is
"you may not read vehicles".

ADR-0030 chose the silent page on purpose, and for a good reason in the
general case. With row-level rules, which rows a caller can read depends on
the data, and an error that appears exactly when hidden rows exist would
tell a caller that they exist. So a denied *row* must never be observable.

But two denials are decided without looking at any row:

- **A classified Type** (ADR-0032) is checked against the caller's clearance
  before the adapter runs.
- **A `never` plan** (ADR-0038) is the read policy's own answer, for this
  subject, that it admits no object of the Type.

Both are functions of the policy (or scheme) and the caller alone. They are
the same for every possible dataset, including an empty one, so refusing on
them says nothing about the data.

## Decision

**A `query` is refused when the answer would be the same for every possible
dataset, and silent when it depends on the data.**

**1. A classified Type above the caller's clearance.** `query` throws
`AuthorizationError` (reason: the scheme's generic clearance reason) instead
of returning an empty page. Nothing of the Type is read, as before. The
audit row is the one the classification check already writes.

**2. A `never` plan.** `query` throws `AuthorizationError` (`Not authorized:
read <Type>`, reason: "No object of this Type is readable by this subject")
instead of returning an empty page, after the one deny row it already
writes, and without calling the adapter.

**3. Everything else is unchanged.** A row the object policy denies is
dropped; a predicate plan that excludes every row, an `always` or `unknown`
plan whose per-object decisions all deny, a filter that matches nothing, and
a Type with no rows all return an empty or short page. So does a rule that
can't plan — a plain function — that denies everything: the runtime cannot
tell "denies everything" from "denies these", so it doesn't claim to.

**4. The refusal has the shape of every other.** The same class, the same
`Not authorized: read <Type>` message, a generic reason, no value, a
single audit row. The MCP `query` tool returns it as `isError`; an HTTP
consumer maps it to 403 as it maps any other `AuthorizationError`.

## Consequences

- A consumer of a role-guarded or classified Type now distinguishes "you may
  not read this" from "there is nothing here". The web example in
  `docs/how-to/start-a-project.md` no longer has to explain an empty
  `{"items":[]}` for an anonymous caller.
- **Breaking for a caller that treated an empty page as "no access".** The
  demo's Explorer and its identity hints are updated; nothing is published.
  The changeset is a minor bump of `@typesys/core`.
- **Whether a rule plans now shows.** The same policy written from the
  shipped combinators (`requireRole`, `requireAttributeMatch`, `anyOf`,
  `allOf`) plans exactly and is refused; written as a plain function it
  plans `unknown` and gives an empty page. This is one more reason to build
  rules from the helpers, and it is stated in the rule-writing guide.
- No audit change: a wholesale denial still writes exactly one deny row, and
  the silent cases write what they wrote.
- `explainQuery` is unchanged: it reports the plan, including `never`, and
  decides no access.

**What a human must review before this is trusted in production.** This
code is machine-verified, not human-reviewed.

- **A plan's `never` must not depend on data.** The ABAC combinators and the
  Cedar planner derive plans from the rule's structure and the subject, and
  `checkPlanConformance` checks a custom planner. A planner that returned
  `never` because of what the store holds would turn this refusal into an
  existence oracle. A custom planner and a custom `ClassificationScheme` are
  part of the trusted computing base (ADR-0047).
- **The refusal tells a caller which kind of rule guards a Type.** A caller
  refused wholesale knows the rule is one their identity can decide from;
  a caller given an empty page knows nothing. Type names are already listed
  to every caller, and the refusal names no attribute or value.
- **A subject missing an attribute a rule needs is refused, not emptied.**
  `requireAttributeMatch("ownerId", "userId")` for a subject with no `userId`
  plans `never`. The refusal reveals only a fact about the subject itself.

## Alternatives Considered

- **Refuse whenever no row is returned.** An existence oracle: the error
  would appear exactly when hidden rows exist and not when the Type is
  empty. This is the case ADR-0030 was right about.
- **Keep the empty page and add a flag (`denied: true`) to the result.**
  Non-breaking, and no ADR is amended, but every consumer must know to look,
  and an agent framework that ignores an unknown field keeps reporting "no
  results". The failure mode this ADR exists to remove would stay the
  default.
- **Leave it, and document it.** Correct and safe, and what ADR-0030 chose;
  rejected because the cost falls on agents and on users of web APIs, for a
  case where refusing discloses nothing.
- **Ask the policy a type-level question and refuse on a deny.** A
  type-level request means "every instance" (ADR-0030), so a row-level rule
  denies it for everyone it doesn't allow unconditionally. That would refuse
  the owner of one row.
