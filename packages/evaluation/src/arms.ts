import type { ArmId } from "./types.js";

/**
 * The runtime as it stood before the composition platform (ADR-0052 to
 * ADR-0063): the core, its adapters, authentication and the MCP server, and
 * the two models the tasks run on. An application on it writes its own
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
  "@typesys/sortie-readiness"
] as const;

/** What the composition platform adds: the governed HTTP API, workflows, the SDK and React bindings, packs, Studio and the engineering loop. */
export const COMPOSITION_PLATFORM = ["@typesys/http", "@typesys/workflow", "@typesys/sdk", "@typesys/react", "@typesys/packs", "@typesys/studio", "@typesys/devkit", "@typesys/engineer"] as const;

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
  "agent-with": { id: "agent-with", title: "An AI agent with the composition platform", producer: "agent", packages: [...ORIGINAL_RUNTIME, ...COMPOSITION_PLATFORM], engineerTools: true }
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
      ? "The engineering loop is available: the `typesys-engineer` MCP tools and the `typesys-engineer` skill (plan, scaffold, verify a mission spec)."
      : "Write the HTTP API, the workflow and its approvals yourself over `SemanticRuntime`.",
    "",
    "Work until you believe the application meets the requirement, then stop."
  ].join("\n");
}
