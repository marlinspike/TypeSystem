# How to generate TypeScript types for your domain

```bash
npx tsx packages/cli/src/bin.ts generate-types ./fleet --bindings ./fleet/bindings.mjs --out ./fleet/types.generated.ts
```

Walks every currently-registered Type (core's own types included) and
emits one `export interface` per Type:

```ts
export interface Widget extends Asset, Trackable {
  status: "active" | "retired";
}
```

- `extends BaseName` for a Type's `extends` chain.
- `extends TraitName` for each trait that contributes actual properties
  (a trait with only relationships, like `Ownable`, contributes nothing
  to emit and is correctly skipped).
- Enums become string-literal unions; computed properties become
  optional fields with a doc comment naming their dependencies.
- Relationships and Actions are documented in a header comment, **never**
  emitted as fields — a relationship isn't a plain value, it's something
  you navigate via the runtime, and blurring that distinction in the
  generated types would undo the whole point of keeping them separate
  (see [ADR-0003](../adr/0003-relationships-as-first-class-records.md)
  and [ADR-0005](../adr/0005-actions-as-first-class-governed-capabilities.md)).

## Why it always needs the *whole* registry, not just your Types

An `extends`/trait target left out of the generation set would produce an
interface referencing an undefined name. `generateModule` always operates
on every registered Type for exactly this reason — there's no
`--only-my-types` flag, and there shouldn't be one; completeness here is
what keeps the output valid TypeScript every time.

## This is not a general JSON Schema → TypeScript compiler

It covers the subset of JSON Schema this project's own schemas actually
use — flat primitives, enums, arrays of those, plus this project's own
`extends`/trait composition model, resolved via the registry's own
`getType`/`getTraitSchema` rather than by parsing raw schema JSON. A
generic converter has no way to know what `x-relationships`/`x-computed`
even mean; this one doesn't need to guess, because it's built around the
meta-model directly.

## Using it programmatically instead of via the CLI

```ts
import { generateModule } from "@typesys/cli";

const code = await generateModule(registry); // registry: SemanticRegistry, already populated
```

Useful for a build script that generates types as part of your own app's
build, rather than a separate manual step.

## Verify it

[`packages/cli/test/codegen.test.ts`](../../packages/cli/test/codegen.test.ts)
doesn't just assert on the generated string — it writes the output to a
temp file and actually runs `tsc --strict --noEmit` against it, so a
change here that produces subtly-invalid TypeScript fails a real
compilation, not a string match.
