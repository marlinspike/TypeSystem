import type { PackArchive } from "@typesys/packs";
import type { GenerateResult, LanguageModel } from "@typesys/llm";
import { baseline, type Proposal } from "./proposal.js";
import { refine, type RefineOptions } from "./refine.js";
import { applyReview, carryForward, type Review, type ReviewOutcome } from "./review.js";
import { sourceModel, type CollectedSource, type SourceModel } from "./sources.js";
import { verifyProposal, type Verification } from "./verify.js";

export interface OnboardInput {
  /** The namespace of every Type: `mx`. */
  readonly domain: string;
  readonly sources: readonly CollectedSource[];
  /** A development-time model. Without one, the proposal is the deterministic baseline. */
  readonly model?: LanguageModel;
  readonly refineOptions?: RefineOptions;
  /** The review so far; without one, nothing is approved yet. */
  readonly review?: Review;
  /** What the last run approved, carried into this one. */
  readonly approved?: Proposal;
  /** The pack this run's would replace, for the upgrade check. */
  readonly previous?: PackArchive;
  readonly version?: string;
  readonly now?: () => number;
}

/** What a run measured: what it proposed, what the model did, and what is left to a person. */
export interface OnboardMetrics {
  readonly evidence: number;
  readonly proposed: { readonly types: number; readonly properties: number; readonly relationships: { readonly declared: number; readonly inferred: number }; readonly sensitive: number; readonly actions: number; readonly findings: number };
  /** What the model proposed that verification refused. */
  readonly rejected: number;
  readonly approved: { readonly types: number; readonly properties: number; readonly relationships: number; readonly sensitive: number; readonly actions: number };
  /** Items an expert must still decide. */
  readonly pending: number;
  readonly model?: { readonly id: string; readonly inputTokens: number; readonly outputTokens: number; readonly estimated: boolean; readonly costUsd?: number; readonly latencyMs: number; readonly attempts: number };
  /** The generated pack and adapter configuration, in bytes of JSON. */
  readonly generatedBytes: number;
  readonly ms: { readonly baseline: number; readonly refine: number; readonly verify: number };
}

export interface OnboardResult {
  readonly sources: SourceModel;
  readonly baseline: Proposal;
  /** The baseline refined by the model (or the baseline), with what was approved before carried in. */
  readonly proposal: Proposal;
  readonly refinement?: GenerateResult;
  readonly review: ReviewOutcome;
  /** Verification of what is approved: what would be installed. */
  readonly verification: Verification;
  readonly metrics: OnboardMetrics;
}

/**
 * One onboarding run (ADR-0076): evidence, a deterministic baseline, an
 * optional model refinement checked against the evidence, what was approved
 * before carried forward, the expert's review applied, and the approved
 * model verified. Only what an expert approved is ever verified for
 * installation; the proposal is for them to review.
 */
export async function onboard(input: OnboardInput): Promise<OnboardResult> {
  const clock = input.now ?? (() => performance.now());
  const model = sourceModel(input.sources);
  let t = clock();
  const base = baseline(model, input.domain);
  const msBaseline = clock() - t;
  t = clock();
  let proposal = base;
  let refinement: GenerateResult | undefined;
  if (input.model) {
    const r = await refine(model, base, input.model, input.refineOptions);
    proposal = r.proposal;
    refinement = r.result;
  }
  const msRefine = clock() - t;
  if (input.approved) proposal = carryForward(model, input.approved, proposal);
  const review = applyReview(proposal, input.review ?? { format: "typesys.onboarding-review/1", domain: input.domain, decisions: {} });
  t = clock();
  const verification = await verifyProposal(model, review.approved, { ...(input.version ? { version: input.version } : {}), ...(input.previous ? { previous: input.previous } : {}) });
  const msVerify = clock() - t;
  const a = review.approved;
  const usage = refinement?.record.usage;
  return {
    sources: model,
    baseline: base,
    proposal,
    ...(refinement ? { refinement } : {}),
    review,
    verification,
    metrics: {
      evidence: model.evidence.size,
      proposed: {
        types: proposal.types.length,
        properties: proposal.types.reduce((n, x) => n + x.properties.length, 0),
        relationships: { declared: proposal.relationships.filter((r) => r.basis !== "inferred").length, inferred: proposal.relationships.filter((r) => r.basis === "inferred").length },
        sensitive: proposal.sensitive.length,
        actions: proposal.actions.length,
        findings: proposal.findings.length
      },
      rejected: proposal.rejected.length,
      approved: { types: a.types.length, properties: a.types.reduce((n, x) => n + x.properties.length, 0), relationships: a.relationships.length, sensitive: a.sensitive.length, actions: a.actions.length },
      pending: review.pending.length,
      ...(refinement
        ? {
            model: {
              id: refinement.record.model.id,
              inputTokens: usage?.inputTokens ?? 0,
              outputTokens: usage?.outputTokens ?? 0,
              estimated: usage?.estimated === true,
              ...(refinement.record.cost ? { costUsd: refinement.record.cost.amount } : {}),
              latencyMs: refinement.record.latencyMs,
              attempts: refinement.record.attempts
            }
          }
        : {}),
      generatedBytes: verification.pack ? JSON.stringify(verification.pack).length + JSON.stringify(verification.built.adapters).length : 0,
      ms: { baseline: Math.round(msBaseline), refine: Math.round(msRefine), verify: Math.round(msVerify) }
    }
  };
}
