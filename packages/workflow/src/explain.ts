import { AuthorizationError, decideForIdentity, EXPLANATION_CAVEAT, type Finding, type Identity, type PolicyEngine, type SemanticRuntime } from "@typesys/core";
import { audienceOf, type AiModel } from "./ai.js";
import type { AnyWorkflow } from "./definition.js";

export const WORKFLOW_EXPLANATION_FORMAT = "typesys.workflow-explanation/1";

/**
 * Whether a subject may start a workflow, approve each of its approvals and
 * invoke each of its Actions, and what its AI steps may be given (ADR-0089).
 * Each decision is made now by the same engine a run uses; the Actions are
 * decided per Type, so an instance-scoped one can still be refused on one
 * object. A run decides everything again, as the identity it holds then.
 */
export interface WorkflowExplanation {
  readonly format: typeof WORKFLOW_EXPLANATION_FORMAT;
  readonly workflow: string;
  readonly version: string;
  readonly subject: string;
  readonly investigator: string;
  readonly disclosure: "inspector" | "caller";
  readonly canStart: boolean;
  readonly findings: readonly Finding[];
  readonly caveat: string;
}

export interface WorkflowExplainContext {
  readonly runtime: SemanticRuntime;
  readonly policyEngine: PolicyEngine;
  readonly models?: Readonly<Record<string, AiModel>>;
  readonly model?: AiModel;
}

async function ruleOf(engine: PolicyEngine, policy: string): Promise<string | undefined> {
  if (typeof engine.describe !== "function") return undefined;
  try {
    const text: unknown = await engine.describe(policy);
    return typeof text === "string" ? text.slice(0, 4_000) : undefined;
  } catch {
    return undefined;
  }
}

/** Explains `workflow` for `as` (default the investigator). Another subject's access needs the runtime's inspection policy (ADR-0088). */
export async function explainWorkflow(ctx: WorkflowExplainContext, workflow: AnyWorkflow, investigator: Identity, opts: { as?: Identity } = {}): Promise<WorkflowExplanation> {
  const subject = opts.as ?? investigator;
  const inspector = await ctx.runtime.canInspect(investigator);
  if (opts.as !== undefined && !inspector) throw new AuthorizationError("Not authorized: explain another subject's access", "Explaining another subject's access needs the inspection policy");
  const findings: Finding[] = [];
  const decided = async (about: string, policy: string, actionName: string, control: Finding["control"]): Promise<boolean> => {
    const d = await decideForIdentity(ctx.policyEngine, { subject, action: "invoke", policyName: policy, resource: { typeName: workflow.name, actionName } });
    const rule = inspector ? await ruleOf(ctx.policyEngine, policy) : undefined;
    findings.push({
      about,
      outcome: d.allow ? "allowed" : "refused",
      basis: "evaluated",
      control,
      ...(inspector ? { policy } : {}),
      ...(rule ? { rule } : {}),
      ...(!d.allow && d.reason ? { reason: inspector ? d.reason : subject.audience ? `Refused while reading for ${subject.audience.id}` : d.reason } : {}),
      ...(!d.allow && rule ? { remedy: `allowed when ${rule}` } : {})
    });
    return d.allow;
  };

  const canStart = await decided(`${workflow.name}.start`, workflow.startPolicy, "start", "action-policy");
  for (const step of workflow.steps) {
    const about = `${workflow.name}.${step.name}`;
    if (step.kind === "approval") {
      await decided(about, step.policy, step.name, "action-policy");
      if (!step.allowSelfApproval) findings.push({ about, outcome: "refused", basis: "structural", control: "action-policy", reason: "the initiator of a run may not approve it: someone else must, even when the policy admits the initiator" });
    } else if (step.kind === "action") {
      const action = (await ctx.runtime.describeModel(subject).catch(() => undefined))?.actions.find((a) => a.name === step.action);
      if (!action) {
        findings.push({ about, outcome: "refused", basis: "evaluated", control: "discovery", reason: `${step.action} is not described to the subject` });
        continue;
      }
      const type = action.target?.type ?? action.applicableTypes[0]!;
      const listed = (await ctx.runtime.listActions(type, subject).catch(() => [])).find((l) => l.action.name === step.action);
      const policy = inspector ? (await ctx.runtime.inspectModel(investigator, { types: [type] }).catch(() => undefined))?.actions.find((a) => a.name === step.action)?.policy : undefined;
      findings.push({
        about,
        outcome: listed?.authorized ? "allowed" : "refused",
        basis: "evaluated",
        control: "action-policy",
        reason: listed?.authorized ? `${step.action} on ${type}` : listed?.instanceScoped ? `${step.action} is decided on each ${type}: the subject is not allowed it on every one` : `the subject may not invoke ${step.action}`,
        ...(policy ? { policy } : {})
      });
    } else if (step.kind === "ai") {
      const model = step.model ? ctx.models?.[step.model] : ctx.model;
      const audience = model ? audienceOf(model) : undefined;
      findings.push({
        about,
        outcome: audience ? "allowed" : "unavailable",
        basis: "structural",
        control: "audience",
        reason: audience
          ? `its input is released to ${audience.id} only as far as both the subject and that audience may read it (release: ${step.release ?? "refuse"})`
          : `the engine has no model ${step.model ? `"${step.model}"` : "by default"}`
      });
    }
  }
  return {
    format: WORKFLOW_EXPLANATION_FORMAT,
    workflow: workflow.name,
    version: workflow.version,
    subject: subject.subjectId,
    investigator: investigator.subjectId,
    disclosure: inspector ? "inspector" : "caller",
    canStart,
    findings,
    caveat: EXPLANATION_CAVEAT
  };
}
