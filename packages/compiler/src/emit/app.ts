import { generateModel } from "@typesys/sdk";
import type { AppAnalysis } from "../check.js";
import type { AppSpec } from "../ir.js";
import { tsType, tsTypeOf } from "../types.js";
import { GENERATED } from "./flows.js";
import { comment, ident, moduleAlias, pascal, q } from "./ts.js";

/** The typed client model, as `typesys generate-sdk` writes it, named for the application. */
export function modelSource(analysis: AppAnalysis): string {
  return generateModel(analysis.model, { name: "AppModel" }).replace(/^\/\/ GENERATED[^\n]*/, GENERATED("the host's model"));
}

/**
 * The contracts handwritten code is held to (ADR-0082): each function an
 * expression calls and each custom component a page shows, typed from the
 * application. `contracts-check.ts` assigns each extension's export to its
 * contract, so tsc reports an extension that drifted from the application
 * at the extension, not at a call site.
 */
export function contractsSource(analysis: AppAnalysis): string {
  const parts: string[] = [GENERATED("app.json"), 'import type { ComponentType } from "react";', ""];
  for (const c of Object.values(analysis.fns).sort((a, b) => a.fn.localeCompare(b.fn))) {
    const T = contractName(c.module, c.export);
    // Every argument may be unknown (withheld, skipped, not yet read): the function decides what that means, never a guess.
    const args = Object.entries(c.args).map(([k, v]) => `  readonly ${ident(k)}: ${tsTypeOf({ ...v, withheld: true })};`);
    parts.push(
      `/** \`${c.fn}\`: called with these arguments, each possibly unknown, and returns this or undefined (unknown). */`,
      `export interface ${T}Args {\n${args.join("\n")}\n}`,
      `export type ${T} = (args: ${T}Args) => ${tsType(c.returns)} | undefined;`,
      ""
    );
  }
  for (const c of Object.values(analysis.components).sort((a, b) => a.component.localeCompare(b.component))) {
    const T = contractName(c.module, c.export);
    const props = Object.entries(c.props).map(([k, v]) => `  readonly ${ident(k)}: ${tsType(v)} | undefined;`);
    parts.push(`/** \`${c.component}\`: a component shown with these props; any of them may be unknown while data load or when withheld. */`, `export interface ${T}Props {\n${props.join("\n")}\n}`, `export type ${T} = ComponentType<${T}Props>;`, "");
  }
  if (parts.length === 3) parts.push("export {};", "");
  return parts.join("\n");
}

/** Each extension's export, assigned to its contract: tsc is the check. */
export function contractsCheckSource(analysis: AppAnalysis): string {
  const fns = Object.values(analysis.fns);
  const comps = Object.values(analysis.components);
  const modules = [...new Set([...fns.map((f) => f.module), ...comps.map((c) => c.module)])].sort();
  if (modules.length === 0) return `${GENERATED("app.json")}\nexport {};\n`;
  const names = [...fns.map((f) => contractName(f.module, f.export)), ...comps.map((c) => contractName(c.module, c.export))].sort();
  const lines = [
    GENERATED("app.json"),
    `import type { ${names.join(", ")} } from "./contracts.js";`,
    ...modules.map((m) => `import * as ${moduleAlias(m)} from "../extensions/${m}.js";`),
    "",
    "/** Every handwritten export the application calls, as its contract types it. A mismatch is a compile error here. */",
    "export const contracts = {",
    ...fns.map((f) => `  ${q(f.fn)}: ${moduleAlias(f.module)}.${f.export} satisfies ${contractName(f.module, f.export)},`),
    ...comps.map((c) => `  ${q(c.component)}: ${moduleAlias(c.module)}.${c.export} satisfies ${contractName(c.module, c.export)},`),
    "};",
    ""
  ];
  return lines.join("\n");
}

export const contractName = (module: string, name: string): string => `${pascal(module)}${pascal(name)}`;

/**
 * A handwritten module's first version, written once and never again
 * (ADR-0082): each export typed by its contract and failing plainly until
 * someone writes it. After that the file is the developer's.
 */
export function extensionStub(analysis: AppAnalysis, module: string): string {
  const fns = Object.values(analysis.fns).filter((f) => f.module === module);
  const comps = Object.values(analysis.components).filter((c) => c.module === module);
  const depth = "../".repeat(module.split("/").length);
  const types = [...fns.map((f) => contractName(f.module, f.export)), ...comps.map((c) => contractName(c.module, c.export))];
  const out = [
    `// Written once by \`typesys app compile\` (ADR-0082). This file is yours: the compiler never writes it again.`,
    `// The types it must satisfy are in src/generated/contracts.ts.`,
    `import type { ${types.join(", ")} } from "${depth}generated/contracts.js";`,
    ""
  ];
  for (const f of fns) out.push(`/** ${comment(f.fn)} */`, `export const ${f.export}: ${contractName(f.module, f.export)} = () => {\n  throw new Error(${q(`${f.fn} is not written yet`)});\n};`, "");
  for (const c of comps) out.push(`/** ${comment(c.component)} */`, `export const ${c.export}: ${contractName(c.module, c.export)} = () => null;`, "");
  return out.join("\n");
}

/** The server extension: how the application reaches custom LLM providers. Written once; the developer's after that. */
export const SERVER_EXTENSION = `// Written once by \`typesys app compile\` (ADR-0082). This file is yours: the compiler never writes it again.
import type { LlmOptions } from "@typesys/llm";

/**
 * Options for the application's language models (ADR-0074): adapters for a
 * custom provider in typesys.llm.json, secrets from somewhere other than the
 * environment. Return {} when every provider is a standard one.
 */
export async function llmOptions(): Promise<LlmOptions> {
  return {};
}
`;

/** The application's entry point: what \`dist/server.js\` runs, and what \`verify\` starts. */
export function serverSource(app: AppSpec, flowKeys: readonly string[]): string {
  const opts = app.host.options ? JSON.stringify(app.host.options) : "";
  const models = Object.entries(app.models ?? {}).map(([role, m]) => `${ident(role)}: ${q(m.id)}`);
  return `${GENERATED("app.json")}
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Express } from "express";
import { createAppServer${app.llm ? ", readLlmConfig" : ""} } from "@typesys/app/server";
import type { AnyWorkflow, WorkflowEngine } from "@typesys/workflow";
import * as host from ${q(app.host.module)};
${flowKeys.map((k) => `import { ${k} } from "./src/generated/flows/${k}.js";`).join("\n")}
${app.llm ? 'import { llmOptions } from "./src/extensions/server.js";\n' : ""}
const here = path.dirname(fileURLToPath(import.meta.url));
/** The application's directory: \`dist/\` is one level down. */
const root = path.resolve(here, "..");

/** ${comment(app.title)}: the governed API over the host, its flows on the workflow engine, its client beside them. */
export async function createApp(): Promise<{ app: Express; workflows: WorkflowEngine }> {
  return createAppServer({
    backend: await host.${app.host.build}(${opts}),
    identities: (token) => host.${app.host.identities}(token),
    // Each flow is typed by the application's model; the engine registers any workflow.
    flows: [${flowKeys.join(", ")}] as unknown as AnyWorkflow[],${models.length ? `\n    models: { ${models.join(", ")} },` : ""}${app.llm ? `\n    llm: { config: readLlmConfig(path.join(root, ${q(app.llm)})), options: await llmOptions() },` : ""}
    clientDir: path.join(here, "client"),
    title: ${q(app.title)}
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { app } = await createApp();
  const server = app.listen(Number(process.env.PORT ?? 4700), "127.0.0.1", () => {
    const url = \`http://127.0.0.1:\${(server.address() as AddressInfo).port}\`;
    // verify waits for this exact line, with the nonce it passed, rather than anything else printed first.
    console.log(process.env.TYPESYS_ENGINEER_READY ? \`typesys-engineer-ready \${process.env.TYPESYS_ENGINEER_READY} \${url}\` : \`${app.title.replaceAll("`", "'").replaceAll("$", "")} on \${url}\`);
  });
}
`;
}

/** Strict, emitting to \`dist/\`, resolving packages as a bundler does. */
export const APP_TSCONFIG = {
  compilerOptions: {
    target: "ES2023",
    lib: ["ES2023", "DOM", "DOM.Iterable"],
    types: ["node"],
    module: "preserve",
    moduleResolution: "bundler",
    jsx: "react-jsx",
    strict: true,
    noUncheckedIndexedAccess: true,
    skipLibCheck: true,
    resolveJsonModule: true,
    verbatimModuleSyntax: true,
    outDir: "dist",
    rootDir: "."
  },
  include: ["server.ts", "src/**/*.ts", "src/**/*.tsx"],
  exclude: ["dist", "**/*.test.ts"]
};

export function indexHtml(app: AppSpec): string {
  const title = app.title.replace(/[<>&"]/g, "");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="icon" href="data:," />
    <link rel="stylesheet" href="/app.css" />
    <title>${title}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/app.js"></script>
  </body>
</html>
`;
}

/** The acceptance checks as a vitest suite: each API check through the running application, each screen check in Chromium. */
export function acceptanceSource(app: AppSpec): string {
  return `${GENERATED("app.json /acceptance")}
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runAppCheck, type AppSpec } from "@typesys/compiler";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const spec = JSON.parse(readFileSync(path.join(root, "app.json"), "utf8")) as AppSpec;

/** ${comment(app.title)}: every acceptance check, each against its own freshly started copy of the built application. */
describe(spec.name, () => {
  for (const check of spec.acceptance) {
    it(\`\${check.id}\${check.because ? \`: \${check.because}\` : ""}\`, async () => {
      const result = await runAppCheck(root, spec, check);
      expect(result.ok, JSON.stringify(result.observed)).toBe(true);
    }, 60_000);
  }
});
`;
}
