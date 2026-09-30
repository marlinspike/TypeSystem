import { randomUUID } from "node:crypto";
import {
  isAuthorizedPartial,
  policySetTextToParts,
  policyToJson,
  preparsePolicySet,
  preparseSchema,
  statefulIsAuthorized,
  validate,
  type AuthorizationAnswer,
  type Schema
} from "@cedar-policy/cedar-wasm/nodejs";
import { NEVER, type AuthorizationPlan, type PolicyDecision, type PolicyEngine, type PolicyRequest } from "@typesys/core";
import { CedarPolicyError } from "./errors.js";
import { cedarEntityType, toCedarPrincipal, toCedarRequest, type AttributeIndex } from "./mapping.js";
import { planFromResiduals } from "./planner.js";
import { indexSchema, messagesOf } from "./schema.js";

/** Why a decision failed closed, with Cedar's own messages — which can quote attribute values, so they never reach the caller. */
export interface CedarErrorDetail {
  policyName: string;
  messages: string[];
}

export interface CedarPolicyEngineOptions {
  /** The Cedar schema, in Cedar's schema syntax or its JSON form. It declares every policy name as a `TypeS::Action` and is the allow-list of attributes a policy can see. */
  schema: Schema;
  /** The policy set, in Cedar's policy syntax. A policy's `@id("...")` annotation becomes its id in decisions and audit reasons. */
  policies: string;
  /** Receives the detail of every decision that failed closed on a Cedar error — route it to an operator's log. */
  onError?: (detail: CedarErrorDetail) => void;
  /**
   * The deployment's assertion that its stores only ever hold values of the
   * schema's declared types (ADR-0039) — typed columns, check constraints,
   * validated writes. Cedar refuses an object with a mistyped declared
   * attribute, which no filter can exclude, so without it a plan for a Type
   * with declared attributes is never exact. Default `false`.
   */
  schemaConformantData?: boolean;
}

function deny(reason: string): PolicyDecision {
  return { allow: false, reason };
}

/** The policy set keyed by each policy's `@id`, falling back to its position. Templates are refused: nothing here links them. */
function policiesById(text: string): Record<string, string> {
  const parts = policySetTextToParts(text);
  if (parts.type === "failure") throw new CedarPolicyError("The Cedar policies failed to parse", messagesOf(parts.errors));
  if (parts.policy_templates.length > 0) throw new CedarPolicyError("Cedar policy templates are not supported; write static policies");

  const byId: Record<string, string> = {};
  parts.policies.forEach((policy, i) => {
    const json = policyToJson(policy);
    const id = (json.type === "success" ? json.json.annotations?.id : undefined) ?? `policy${i}`;
    if (Object.hasOwn(byId, id)) throw new CedarPolicyError(`Two Cedar policies share the id "${id}"`);
    byId[id] = policy;
  });
  return byId;
}

/**
 * A `PolicyEngine` backed by Cedar, running in-process as WebAssembly
 * (ADR-0031). Construction parses and strictly validates the policies
 * against the schema and throws `CedarPolicyError` on any error or warning,
 * so an engine that exists is one whose every policy type-checks and can
 * fire. Each decision
 * maps the `PolicyRequest` to a Cedar request — the policy name as a
 * `TypeS::Action`, only schema-declared attributes — and allows only on a
 * Cedar `allow` with no evaluation errors: an erroring `forbid` Cedar would
 * skip is a deny here, as is any failed request.
 */
export class CedarPolicyEngine implements PolicyEngine {
  /** Keys this engine's preparsed policy set and schema in cedar-wasm's process-wide cache, so engines never share state. */
  private readonly cacheId = `typesys-${randomUUID()}`;
  private readonly attributeIndex: AttributeIndex;
  private readonly onError?: (detail: CedarErrorDetail) => void;
  private readonly schema: Schema;
  private readonly staticPolicies: Record<string, string>;
  private readonly schemaConformantData: boolean;

  constructor(options: CedarPolicyEngineOptions) {
    this.attributeIndex = indexSchema(options.schema);
    this.onError = options.onError;
    this.schema = options.schema;
    this.schemaConformantData = options.schemaConformantData === true;
    const staticPolicies = policiesById(options.policies);
    this.staticPolicies = staticPolicies;

    const validation = validate({ schema: options.schema, policies: { staticPolicies }, validationSettings: { mode: "strict" } });
    if (validation.type === "failure") throw new CedarPolicyError("The Cedar policies could not be validated", messagesOf(validation.errors));
    // Warnings are refused too: the one Cedar raises for an "impossible" policy is how a typo'd
    // attribute behind a `has` guard shows up, and in a `forbid` that is a silently open door.
    const problems = [...validation.validationErrors, ...validation.validationWarnings];
    if (problems.length > 0) {
      throw new CedarPolicyError("The Cedar policies fail validation against the schema", problems.map((e) => `${e.policyId}: ${e.error.message}`));
    }

    const policies = preparsePolicySet(this.cacheId, { staticPolicies });
    const schema = preparseSchema(this.cacheId, options.schema);
    for (const parsed of [policies, schema]) {
      if (parsed.type === "failure") throw new CedarPolicyError("Cedar could not load the policies", messagesOf(parsed.errors));
    }
  }

  async evaluate(request: PolicyRequest): Promise<PolicyDecision> {
    let answer: AuthorizationAnswer;
    try {
      answer = statefulIsAuthorized({
        ...toCedarRequest(request, this.attributeIndex),
        preparsedPolicySetId: this.cacheId,
        preparsedSchemaName: this.cacheId,
        validateRequest: true
      });
    } catch (err) {
      this.report(request, [err instanceof Error ? err.message : String(err)]);
      return { ...deny(`Cedar could not evaluate "${request.policyName}" (fail closed)`), faults: [`Cedar could not evaluate ${request.policyName}`] };
    }

    if (answer.type === "failure") {
      this.report(request, messagesOf(answer.errors));
      return deny(`Cedar rejected the request for "${request.policyName}" (fail closed)`);
    }
    const { decision, diagnostics } = answer.response;
    if (diagnostics.errors.length > 0) {
      this.report(request, diagnostics.errors.map((e) => `${e.policyId}: ${e.error.message}`));
      // Which policies errored is a fault an operator must see (ADR-0043); Cedar's messages stay in onError.
      return {
        ...deny(`Cedar policy ${diagnostics.errors.map((e) => e.policyId).join(", ")} errored (fail closed)`),
        faults: diagnostics.errors.map((e) => `Cedar policy ${e.policyId} errored`)
      };
    }
    if (decision === "allow") return { allow: true, reason: `Permitted by ${diagnostics.reason.join(", ")}` };
    return deny(diagnostics.reason.length > 0 ? `Forbidden by ${diagnostics.reason.join(", ")}` : `No Cedar policy permits "${request.policyName}"`);
  }

  /**
   * What the policy set admits for this principal and action, across every
   * resource of the Type (ADR-0039): Cedar's partial evaluation with the
   * resource unknown, its residuals translated to a plan. A principal Cedar
   * can't evaluate at all — refused by every full evaluation too — plans
   * `never`; any other failure throws, which the runtime treats as a
   * planner failure.
   */
  async plan(request: PolicyRequest): Promise<AuthorizationPlan> {
    let cedar: ReturnType<typeof toCedarRequest>;
    let principalSide: ReturnType<typeof toCedarPrincipal>;
    try {
      // Type-level: no resource attributes, so a throw here is the principal's, and every evaluation would deny.
      cedar = toCedarRequest(request, this.attributeIndex);
      principalSide = toCedarPrincipal(request, this.attributeIndex);
    } catch {
      return NEVER;
    }
    const answer = isAuthorizedPartial({
      principal: principalSide.principal,
      action: cedar.action,
      resource: null,
      context: cedar.context,
      schema: this.schema,
      validateRequest: false,
      policies: { staticPolicies: this.staticPolicies },
      entities: principalSide.entities
    });
    if (answer.type === "failure") {
      const full = statefulIsAuthorized({ ...cedar, preparsedPolicySetId: this.cacheId, preparsedSchemaName: this.cacheId, validateRequest: true });
      if (full.type === "failure") return NEVER;
      throw new CedarPolicyError(`Cedar could not partially evaluate "${request.policyName}"`, messagesOf(answer.errors));
    }
    const cedarType = cedarEntityType(request.resource.typeName);
    return planFromResiduals(answer.response, {
      policyName: request.policyName,
      cedarType,
      typeName: request.resource.typeName,
      declaresAttributes: (this.attributeIndex.get(cedarType)?.size ?? 0) > 0,
      schemaConformantData: this.schemaConformantData
    });
  }

  private report(request: PolicyRequest, messages: string[]): void {
    this.onError?.({ policyName: request.policyName, messages });
  }
}
