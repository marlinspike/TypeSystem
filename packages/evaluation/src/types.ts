/**
 * The three-arm productivity evaluation (ADR-0073): a task is a requirement
 * and a hidden set of acceptance checks; an arm is a way of producing the
 * application; a run is one arm producing one application for one task.
 */

export type ArmId = "conventional" | "agent-without" | "agent-with";

export interface Task {
  readonly id: string;
  readonly title: string;
  /** Whether the task was written after the engineering loop (M4) was finished, so no tool was tuned to it. */
  readonly afterM4: boolean;
  /** The requirement text every arm is given, word for word. */
  readonly requirement: string;
  /** Names that identify this task's solution, for the contamination scan. */
  readonly markers: readonly string[];
}

/** What a hidden check calls: the application's governed API, as one caller. */
export interface CheckApi {
  call(token: string, method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; body: unknown; ms: number }>;
}

export interface HiddenCheck {
  readonly id: string;
  readonly requirement: string;
  run(api: CheckApi): Promise<void>;
}

export interface CheckOutcome {
  readonly id: string;
  readonly ok: boolean;
  readonly message?: string;
}

/** What the producer of an application reports about producing it. Unknown values are absent, never guessed. */
export interface ProductionLog {
  readonly source: "agent" | "person" | "reference";
  /** Who or what produced it, e.g. a model id or "hand-written reference". */
  readonly producer: string;
  readonly wallMs?: number;
  readonly tokens?: { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number };
  readonly costUsd?: number;
  readonly humanInterventions: number;
  /** Times the producer ran the application's own checks and changed the code because one failed. */
  readonly repairIterations?: number;
  readonly notes?: string;
}

export interface CodeMeasure {
  readonly files: number;
  /** Lines that are neither blank nor only a comment, in source the producer wrote (not node_modules, dist or generated lockfiles). */
  readonly codeLines: number;
  /** Distinct `@typesys/*` and other packages imported. */
  readonly imports: readonly string[];
  /** Places the code calls HTTP or a service directly, rather than through the runtime. */
  readonly directServiceCalls: number;
  /** Policy decisions restated in application code: role or token string literals compared in conditions. */
  readonly restatedAccessRules: number;
  /** Branch points per 100 code lines (if, ?, &&, ||, case, catch): a coarse maintainability measure, lower is simpler. */
  readonly branchDensity: number;
  readonly largestFileLines: number;
}

export interface Performance {
  readonly requests: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
}

export interface RunScore {
  readonly task: string;
  readonly arm: ArmId;
  readonly at: string;
  readonly production: ProductionLog;
  readonly built: boolean;
  readonly started: boolean;
  readonly diagnostic?: string;
  readonly checks: readonly CheckOutcome[];
  readonly passed: number;
  readonly total: number;
  readonly code?: CodeMeasure;
  readonly performance?: Performance;
}
