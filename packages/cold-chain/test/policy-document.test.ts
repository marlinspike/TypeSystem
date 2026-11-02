import { describe, it, expect } from "vitest";
import { allOf, anyOf, comparePolicyRules, requireAttributeMatch, requireRole, type Identity, type PolicyRequest, type PolicyRule } from "@typesys/core";
import { coldChainPolicyRules } from "../src/model.js";
import { recallPolicyRules } from "../src/recalls.js";

/** ADR-0100: the cold chain's rules, rewritten as data, decide exactly as the code they replaced. */

const MODEL = "coldchain-model";
/** The rules as they were written in code before ADR-0100, kept here as the oracle. */
const before: Record<string, PolicyRule> = {
  "coldchain.read-shipment": anyOf(requireRole("logistics", "qa", "auditor", MODEL), allOf(requireRole("carrier"), requireAttributeMatch("carrier", "carrier"))),
  "coldchain.read-site": requireRole("logistics", "qa", "auditor", "carrier", MODEL),
  "coldchain.telemetry": requireRole("logistics", "qa", "auditor", MODEL),
  "coldchain.inventory": requireRole("logistics", "qa", "auditor", MODEL),
  "coldchain.dispose": requireRole("logistics", "qa"),
  "coldchain.qa-release": requireRole("qa"),
  "coldchain.qa": requireRole("qa"),
  "coldchain.inspect": requireRole("qa", "auditor")
};
const publicNotice: PolicyRule = ({ resource }: PolicyRequest) =>
  !resource.attributes || resource.attributes.embargoed === false ? { allow: true } : { allow: false, reason: "A notice under embargo is need-to-know for quality assurance alone" };
const recallBefore: Record<string, PolicyRule> = {
  "coldchain.read-recall": anyOf(requireRole("qa"), allOf(requireRole("logistics", "auditor", MODEL), publicNotice)),
  "coldchain.respond-recall": requireRole("logistics", "qa")
};

const roles = [[], ["logistics"], ["qa"], ["auditor"], ["carrier"], [MODEL], ["logistics", "carrier"], ["somebody"]];
const subjects: Identity[] = roles.flatMap((r, i) => [
  { subjectId: `s${i}`, roles: r, attributes: { carrier: "Northline Cold Freight" } },
  { subjectId: `t${i}`, roles: r, attributes: {} }
]);
const resources = [
  { typeName: "coldchain.Shipment" },
  { typeName: "coldchain.Shipment", objectId: "S1", attributes: { carrier: "Northline Cold Freight" } },
  { typeName: "coldchain.Shipment", objectId: "S2", attributes: { carrier: "Polar Freight" } },
  { typeName: "coldchain.Recall", objectId: "R1", attributes: { embargoed: false } },
  { typeName: "coldchain.Recall", objectId: "R2", attributes: { embargoed: true } },
  { typeName: "coldchain.Recall", objectId: "R3", attributes: {} }
];
const requests = subjects.flatMap((subject) => resources.flatMap((resource) => (["read", "invoke"] as const).map((action) => ({ subject, action, resource }))));

describe("cold chain policies as data (ADR-0100)", () => {
  it("decide, explain and plan exactly as the code did", async () => {
    expect(await comparePolicyRules(before, coldChainPolicyRules, requests)).toEqual([]);
  });

  it("the recall rule decides and plans as before; only its description, once opaque, is now readable", async () => {
    // The embargo test was a plain function: it planned `unknown` as opaque, and now plans `unknown` as unrepresentable.
    const diffs = await comparePolicyRules(recallBefore, recallPolicyRules, requests, { "coldchain.read-recall": ["description", "plan"] });
    expect(diffs).toEqual([]);
    const planDiffs = await comparePolicyRules(recallBefore, recallPolicyRules, requests, { "coldchain.read-recall": ["description"] });
    for (const d of planDiffs) {
      expect(d.what).toBe("plan");
      expect(JSON.stringify(d.before)).toContain("opaque-rule");
      expect(JSON.stringify(d.after)).toContain("unrepresentable-condition");
    }
  });
});
