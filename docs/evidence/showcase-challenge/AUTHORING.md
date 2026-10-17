# Authoring the recall-response challenge

**Who wrote it:** an independent subagent (Claude Opus 5.5), given the task of
authoring a challenge only. It had no access to any solution: it wrote no
TypeSystem model, mapping, policy rule, `app.json` or application code, and
no solution for this task existed when it finished.

**Finished:** Sat Oct 17 19:29:17 UTC 2026.

## What it wrote

- `examples/services/recall-exchange/server.mjs`, `server.d.mts`, `openapi.json`: the new,
  fourth independent service (plain Node, no TypeSystem imports).
- `packages/evaluation/tasks/recall-response/requirement.md` and `task.json`.
- `packages/evaluation/hidden/recall-response.mjs`: 16 hidden checks.
- This note.

## What it read

- `packages/evaluation/tasks/CONTRACT.md`, every `tasks/*/requirement.md` and `task.json`.
- `packages/evaluation/hidden/requisition-expedite.mjs` (for the check format and the
  "assert a permitted caller is served first" convention).
- `packages/evaluation/src/score.ts`, `types.ts`, `tasks.ts`, the top of `sandbox.ts`, and the
  two harness tests (to learn that every task needs at least 8 checks and that a
  404-everything app and an adversarial refuse-everything app must pass none).
- The cold chain: `packages/cold-chain/src/model.ts`, `adapters.ts`, `services.ts`,
  `setup.ts`, `index.ts`, `package.json`; `examples/services/shipment-tracker`,
  `sensor-hub` and `pharmacy-inventory` `server.mjs`; the head of
  `examples/services/crew-roster/openapi.json` and its `server.d.mts` (for style).

## What it deliberately did not read

- Anything under `packages/evaluation/references/` (solutions to other tasks).
- The other two hidden check files beyond `requisition-expedite.mjs`, existing mission
  applications (`examples/missions`, `packages/mission-readiness`), and the
  `typesys-engineer` skill: none was needed to write the problem, and reading them could
  bias the challenge toward what the platform already does.

## Verification done

- Started the service with `PORT=0 node examples/services/recall-exchange/server.mjs`;
  exercised it with curl: no credentials and a wrong secret (401), list and paging,
  the viewer client's embargo filter (404 on the embargoed notice) and its refused write
  (403), an invalid body (400), a lot not on the notice (422), a good response (201),
  a second response (409 ALREADY_RESPONDED), a terminated notice (409), and the response
  read back on the notice; then stopped it.
- `node --check` on the hidden checks and the service. A stub run of the checks against a
  404-everything app, the harness's adversarial refuse-everything app, and an
  allow-everything app passed none.
- Re-read the requirement against every check; each assertion is on seeded data.

## Ambiguities resolved

- **Who may approve when QA asks.** The host has one QA person; separation of duties could
  never be satisfied for her requests. Resolved by adding a second QA person,
  Dr. Tomasz Brandt (`demo-qa2-token`), and saying the application must resolve that token.
- **What "in transit" means when systems disagree.** The inventory calls lot L-7770
  in transit while the tracker shows its shipment SH-1048 held. The requirement says the
  tracker decides, in so many words, and one check rests on it.
- **NDC format.** The exchange writes NDCs as 11 digits, the inventory hyphenated; the
  requirement says so explicitly so the product-mismatch rule is a fair join.
- **Lots on a notice we never held** (L-7795) are said to be normal and are not part of
  the response; they do not make the request fail.
- **Embargoed notice and a coordinator.** Stated explicitly that she may not ask (403),
  rather than leaving 403 versus a failed run open.
- **A response filed before the application existed** (RCL-26-0360) is said to count as
  "already answered" and to be read through the same fields.
- Left untested and marked in the check file: an unknown recall number, and whether the
  response fields are absent or null before a response exists.
- The harness test "the reference application passes every hidden check" iterates every
  task, so it will fail for this task until someone else writes a reference; this author
  deliberately did not.
