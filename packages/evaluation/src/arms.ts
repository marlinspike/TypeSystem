import type { ArmId } from "./types.js";

/**
 * The runtime as it stood before the composition platform (ADR-0052 to
 * ADR-0063): the core, its adapters, authentication and the MCP server, and
 * the models the tasks run on. An application on it writes its own
 * HTTP API, workflow and client.
 */
export const ORIGINAL_RUNTIME = [
  "@typesys/core",
  "@typesys/adapter-in-memory",
  "@typesys/adapter-mock-rest",
  "@typesys/adapter-http",
  "@typesys/auth-oidc",
  "@typesys/policy-cedar",
  "@typesys/domain-airforce",
  "@typesys/sortie-readiness",
  "@typesys/cold-chain"
] as const;

/** What the composition platform adds: the governed HTTP API, workflows, the SDK and React bindings, packs, Studio and the engineering loop. */
export const COMPOSITION_PLATFORM = ["@typesys/http", "@typesys/workflow", "@typesys/sdk", "@typesys/react", "@typesys/packs", "@typesys/studio", "@typesys/devkit", "@typesys/engineer"] as const;

/**
 * What 4.0 and 5.0 add for building and understanding: the application
 * compiler and its runtime and components, models as audiences, onboarding
 * from source metadata, and the CLI that drives them (`typesys app context,
 * check, compile, verify, inspect, why, graph, impact, links`, `typesys onboard`).
 */
export const SEMANTIC_TOOLING = ["@typesys/compiler", "@typesys/app", "@typesys/ui", "@typesys/llm", "@typesys/onboard", "@typesys/cli"] as const;

export interface Arm {
  readonly id: ArmId;
  readonly title: string;
  /** Who produces the application. */
  readonly producer: "person" | "agent";
  readonly packages: readonly string[];
  /** Whether the engineering loop's MCP tools and skill are offered. */
  readonly engineerTools: boolean;
}

export const ARMS: Readonly<Record<ArmId, Arm>> = {
  conventional: { id: "conventional", title: "A developer, by hand, on the original runtime", producer: "person", packages: ORIGINAL_RUNTIME, engineerTools: false },
  "agent-without": { id: "agent-without", title: "An AI agent without the composition platform", producer: "agent", packages: ORIGINAL_RUNTIME, engineerTools: false },
  "agent-with": { id: "agent-with", title: "An AI agent with the composition platform", producer: "agent", packages: [...ORIGINAL_RUNTIME, ...COMPOSITION_PLATFORM, ...SEMANTIC_TOOLING], engineerTools: true }
};

/** The brief every producer of an arm is given, around the task's own text, which is passed word for word. */
export function armBrief(arm: Arm): string {
  return [
    `# How to build it (${arm.title})`,
    "",
    "Build the application this directory's REQUIREMENT.md describes, to the contract in CONTRACT.md, in the `app/` directory.",
    "Acceptance tests you cannot see will be run against it, as each person in the requirement, through the contract's API.",
    "",
    `You may use only these packages from this repository: ${arm.packages.map((p) => `\`${p}\``).join(", ")}, and Node's own modules.`,
    arm.engineerTools
      ? [
          "The engineering loop is available: the `typesys-engineer` MCP tools and the `typesys-engineer` skill (plan, scaffold, verify a mission spec).",
          "So are the semantic tools, as `node packages/cli/dist/bin.js` (the `typesys` CLI): `app context`, `app inspect`, `app why`, `app graph`, `app links` and `app impact` to understand the model as each caller sees it; `app check`, `app compile`, `app build` and `app verify` to build an application from an `app.json` (examples/apps/cold-chain is one); and `onboard` to propose a governed model from a source's OpenAPI document."
        ].join("\n")
      : "Write the HTTP API, the workflow and its approvals yourself over `SemanticRuntime`.",
    "",
    "Work until you believe the application meets the requirement, then stop."
  ].join("\n");
}
