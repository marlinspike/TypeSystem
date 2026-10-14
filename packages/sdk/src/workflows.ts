import { httpCall, type HttpTransportOptions } from "./transport.js";

/** A workflow run as `@typesys/http` returns it (`RunView`, ADR-0057). */
export interface WorkflowRun {
  readonly runId: string;
  readonly workflow: string;
  readonly version: string;
  readonly status: "running" | "waiting-approval" | "compensating" | "completed" | "failed" | "rejected" | "needs-reconciliation";
  readonly initiator: string;
  readonly waitingOn?: { readonly step: string; readonly policy: string };
  readonly reason?: string;
  readonly steps: readonly { readonly name: string; readonly status: string; readonly attempts: number }[];
  readonly startedAt: string;
  readonly updatedAt: string;
}

/** What an approver the workflow's policy admits is shown (ADR-0057). */
export interface WorkflowApproval {
  readonly runId: string;
  readonly workflow: string;
  readonly step: string;
  readonly policy: string;
  readonly initiator: string;
  readonly presented: unknown;
}

/** Governed workflows over the REST API, as the token's caller. The engine decides who may start, see and approve. */
export interface WorkflowsClient {
  start(workflow: string, input: unknown): Promise<WorkflowRun>;
  status(runId: string): Promise<WorkflowRun>;
  /** Every completed step's output; only the run's initiator may read them. */
  outputs(runId: string): Promise<Record<string, unknown>>;
  /** The approval the run waits on, for an approver its policy admits. */
  approval(runId: string): Promise<WorkflowApproval>;
  approve(runId: string, step: string, decision: { readonly approved: boolean; readonly comment?: string }): Promise<WorkflowRun>;
  /** Every approval waiting on someone this caller may be. */
  approvals(): Promise<WorkflowApproval[]>;
}

/** Calls a TypeSys REST API's workflow routes (`@typesys/http` with `workflows`). Refusals are `ApiError`s, as for `httpTransport`. */
export function httpWorkflows(opts: HttpTransportOptions): WorkflowsClient {
  const call = httpCall(opts);
  const seg = encodeURIComponent;
  return {
    start: async (workflow, input) => (await call("POST", `/workflows/${seg(workflow)}/runs`, { input })) as WorkflowRun,
    status: async (runId) => (await call("GET", `/workflow-runs/${seg(runId)}`)) as WorkflowRun,
    outputs: async (runId) => (await call("GET", `/workflow-runs/${seg(runId)}/outputs`)) as Record<string, unknown>,
    approval: async (runId) => (await call("GET", `/workflow-runs/${seg(runId)}/approval`)) as WorkflowApproval,
    approve: async (runId, step, decision) => (await call("POST", `/workflow-runs/${seg(runId)}/approvals/${seg(step)}`, decision)) as WorkflowRun,
    approvals: async () => (await call("GET", "/workflow-approvals")) as WorkflowApproval[]
  };
}
