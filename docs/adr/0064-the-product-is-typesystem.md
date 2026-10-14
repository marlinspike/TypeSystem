# 0064. The Product Is TypeSystem, or TypeSys

## Status

Accepted (2026-10-14).

## Context

The project's earlier documents, comments, UI strings and package
descriptions used a third, shorter name for the product beside TypeSystem
and TypeSys. The owner has ruled that the product is called **TypeSystem**,
or **TypeSys** for short, and that the third name is never used. It had
spread to 115 tracked files: the README and every kind of doc, ADRs,
JSDoc, CLI help, server log lines, the Studio's title, the demo console,
package descriptions, the Cedar namespace every policy is written in, the
React binding's factory and provider names, and a demo response header.

## Decision

1. **Prose says TypeSystem or TypeSys.** TypeSystem where the full product
   name reads naturally (the README's opening, titles), TypeSys elsewhere.
   ADRs are corrected too: the change is to a name, not to any decision an
   ADR records.
2. **Identifiers that carried the retired name are renamed, without
   aliases.** The Cedar namespace becomes `TypeSys` (`TypeSys::User`,
   `TypeSys::Role`, `TypeSys::Action`), `@typesys/react` exports
   `createTypeSysHooks` and its provider is `TypeSysProvider`, and the demo
   console's stats header is `X-TypeSys-Stats`. No `@typesys/*` package has
   been published (every package is still `0.1.0` with unconsumed
   changesets, ADR-0020), so the only consumers are in this repository and
   change with it. A deployment that wrote its own Cedar schema renames its
   namespace; the engine's load-time schema validation reports a schema
   that still uses the old one, since `TypeSys::User` is then undeclared.
3. **Every other identifier is unchanged.** Package names (`@typesys/*`),
   MCP tool names (`typesys_*`), metric and span names (`typesys.*`), the
   CLI binary, environment variables, the pack file suffix and every API
   were already spelled `typesys` and keep their compatibility.
4. **A check keeps it that way.** `npm run check:terminology`
   (`tools/terminology/terminology.ts`, run by `scripts/check-terminology.ts`)
   reads every tracked or new, unignored text file and fails on the retired
   name not followed by a lowercase letter, so `TypeScript`, `TypeSys`,
   `TypeSystem` and `Types` pass. CI runs it beside lint. A line that must
   quote the retired name carries `terminology-allow` and a reason; there
   are none outside the check's own tests.

## Consequences

- Policy authors, Studio users, agents reading `llms.txt` and
  `docs/for-agents.md`, and anyone reading CLI or server output see one
  name.
- The check is lexical: it cannot tell an unrelated word that happens to
  match the retired spelling, which would need the allow marker. None exists
  in the repository today.
- Proven by `tools/terminology/test/terminology.test.ts` (what is caught,
  what passes, the allow marker, skipped formats) and by the check itself
  passing in CI over the whole repository.
