import { mkdir, writeFile, access } from "node:fs/promises";
import path from "node:path";

export interface ScaffoldResult {
  dir: string;
  createdFiles: string[];
}

const EXAMPLE_TYPE_YAML = (domainName: string) => `# Your first Type. Delete this once you've written your own — it exists
# to prove the round trip (validate -> generate-types) works before you've
# written a single line of your own domain logic.
#
# See docs/how-to/add-a-type.md for the full field reference, and
# docs/quickstart.md if you haven't run \`typesys validate\`/\`generate-types\`
# against this directory yet.

name: ${domainName}.Widget
version: 1.0.0
title: Widget
description: A placeholder Type — rename or delete once you have a real one.
extends: core.Asset
traits: [Trackable]

properties:
  status:
    type: string
    enum: [active, retired]
required: [status]

policy:
  objectPolicy: ${domainName}.read-widget
`;

const BINDINGS_MJS = `// Real function implementations for any \`binding\`/\`bindingId\` your YAML
// Types reference under \`computed:\`/preconditions — YAML can only carry
// *names*, never behavior (see docs/adr/0015-postgres-registry-store.md,
// which the YAML loader reuses the same seam from). Nothing in the starter
// example.yaml needs one yet, so this starts empty.
//
// Example, once you add a computed property with \`binding: computeFoo\`:
//
// export default {
//   computed: {
//     computeFoo: async (ctx) => {
//       const status = await ctx.getProperty("status");
//       return status === "active" ? "OK" : "RETIRED";
//     }
//   },
//   preconditions: {}
// };

export default {
  computed: {},
  preconditions: {}
};
`;

const readme = (domainName: string) => `# ${domainName}

Scaffolded by \`typesys init\`. Start here:

\`\`\`bash
npx typesys validate . --bindings ./bindings.mjs
npx typesys generate-types . --bindings ./bindings.mjs --out ./types.generated.ts
\`\`\`

Next steps:

1. Edit \`00-example.yaml\` (or add more \`.yaml\` files — they load in
   alphabetical order, so name base types before the subtypes that
   \`extends\` them).
2. Add real implementations to \`bindings.mjs\` for any \`binding\`/
   \`bindingId\` your Types reference.
3. Wire this domain into a running application — see
   \`docs/how-to/add-a-type.md\` and \`docs/quickstart.md\` in the TypeS repo
   for the full path from here to a queryable object.

Full docs: [docs/README.md](../docs/README.md) in the TypeS repo (or
wherever you vendored these docs from) is the index for everything else —
tutorials, how-tos, the "why use this" pitch, and the architecture
reference.
`;

/**
 * `typesys init <name>` — the first-five-minutes scaffold: one example
 * Type, one empty bindings module, one README with the two commands you
 * actually run next. Never overwrites an existing directory unless
 * `force` is passed.
 */
export async function scaffoldDomain(dir: string, domainName: string, force = false): Promise<ScaffoldResult> {
  const exists = await access(dir).then(
    () => true,
    () => false
  );
  if (exists && !force) {
    throw new Error(`"${dir}" already exists — pass --force to scaffold into it anyway.`);
  }
  await mkdir(dir, { recursive: true });

  const files: Record<string, string> = {
    "00-example.yaml": EXAMPLE_TYPE_YAML(domainName),
    "bindings.mjs": BINDINGS_MJS,
    "README.md": readme(domainName)
  };

  const createdFiles: string[] = [];
  for (const [name, content] of Object.entries(files)) {
    const filePath = path.join(dir, name);
    await writeFile(filePath, content, "utf8");
    createdFiles.push(filePath);
  }

  return { dir, createdFiles };
}
