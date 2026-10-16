import { audienceIdentity, type Audience, type ClassificationScheme } from "@typesys/core";
import type { ContentLabel } from "./types.js";

export interface ReleaseDecision {
  readonly allow: boolean;
  /** For the audit record only: it may name markings. */
  readonly reason?: string;
}

/**
 * Whether content under `label` may be sent to `audience` (ADR-0075),
 * decided by the deployment's classification scheme exactly as the runtime
 * decides a marked value for an audience (ADR-0067): the joined label and
 * every marking on its own, deny-biased. Unmarked content (`[]`) is no
 * decision. Marked content with no scheme to decide it is refused, as the
 * runtime refuses marked data by default. An unlabeled request is allowed
 * unless `requireLabel`: the caller has said nothing about it.
 */
export function decideRelease(scheme: ClassificationScheme | undefined, audience: Audience, label: ContentLabel | undefined, requireLabel = false): ReleaseDecision {
  if (!label) return requireLabel ? { allow: false, reason: "the request carries no label, and this deployment requires one" } : { allow: true };
  const marked = [...new Set(label.markings)];
  if (marked.length === 0) return { allow: true };
  if (!scheme) return { allow: false, reason: "marked content and no classification scheme to decide it" };
  const subject = audienceIdentity(audience);
  const context = { action: "read" as const, resource: { typeName: "typesys.llm.request" } };
  try {
    const joined = scheme.join(marked);
    if (!Array.isArray(joined) || joined.length === 0 || joined.some((m) => typeof m !== "string")) return { allow: false, reason: "the scheme could not join the markings" };
    for (const markings of [joined, ...marked.map((m) => [m])]) {
      const d = scheme.decide({ subject, markings, context });
      if (d?.allow !== true) return { allow: false, reason: `not releasable to ${audience.id}: ${typeof d?.reason === "string" ? d.reason : "refused"}` };
    }
    return { allow: true };
  } catch {
    return { allow: false, reason: "the scheme failed to decide" };
  }
}
