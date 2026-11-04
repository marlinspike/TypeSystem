# 0114. A Meant Upgrade Change Is Accepted, Not Bypassed

## Status

Accepted (2026-11-03). Implemented in `packages/host/src/check.ts`
(`acceptanceFor`, `applyAcceptance`, `validateAcceptance`) and
`typesys deploy check --accept / --write-acceptance`. Proven by
`packages/host/test/usability.test.ts`.

## Context

`typesys deploy check` blocks a change that would let someone read what
they could not before. Many such changes are meant: a role is given a field
it now needs. The check offered no way to say so, so a gate built on it
could only be skipped.

## Decision

An acceptance is a `typesys.deploy-acceptance/1` document naming the two
build ids and, for each blocking line exactly as the check printed it, who
accepted it and why. `--write-acceptance <file> --by <name> --why <reason>`
writes one for every line blocking now, and still exits 1. `--accept
<file>` passes the check only when every blocking line is accepted for
these two builds; it then prints each accepted line with who and why.

One run may not both write an acceptance and pass with it: a person reviews
it first. An acceptance for other builds is refused whole. A line the acceptance
accepts that the check no longer blocks on is itself blocking, since the
change it answered for is not this one. Nothing else changes: the check
still compares the same things the same way.

## Consequences

A deliberate widening goes through review as a file in the pull request,
with a name and a reason on each line. Because exposure lines name the
objects probed, an acceptance written against one state of the data may
not match a check run after the data changes; it then blocks, and is
written again.
