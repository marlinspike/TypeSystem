import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { isAuthorized } from "@cedar-policy/cedar-wasm/nodejs";
import type { Identity, PolicyRequest } from "@typesys/core";
import { CedarPolicyEngine, CedarPolicyError, type CedarErrorDetail } from "../src/index.js";

/**
 * `CedarPolicyEngine` on its own (ADR-0031): the real Cedar authorizer,
 * in-process as WebAssembly — no mocks. The demo domains' schema and policy
 * set are the baseline; each fail-closed case is a small variation of them.
 */
const SCHEMA = readFileSync(new URL("../examples/demo-domains.cedarschema", import.meta.url), "utf8");
const POLICIES = readFileSync(new URL("../examples/demo-domains.cedar", import.meta.url), "utf8");

function engine(overrides: { schema?: string; policies?: string } = {}, errors: CedarErrorDetail[] = []) {
  return new CedarPolicyEngine({ schema: overrides.schema ?? SCHEMA, policies: overrides.policies ?? POLICIES, onError: (d) => errors.push(d) });
}

const clinicianA: Identity = { subjectId: "user-clinician-1", roles: ["clinician"], attributes: { providerId: "PR-2001" } };
const admin: Identity = { subjectId: "user-admin-1", roles: ["admin"], attributes: {} };
const PT_1001 = { id: "PT-1001", name: "Jordan Lee", medicalRecordNumber: "MRN-1001", assignedClinicianId: "PR-2001" };

function readPatient(subject: Identity, attributes?: Record<string, unknown>, objectId = "PT-1001"): PolicyRequest {
  return {
    subject,
    action: "read",
    policyName: "hospital.read-patient",
    resource: { typeName: "hospital.Patient", ...(attributes ? { objectId, attributes: Object.freeze({ ...attributes }) } : {}) }
  };
}

describe("CedarPolicyEngine (ADR-0031)", () => {
  describe("decisions", () => {
    it("allows an assigned clinician, naming the permitting policy by its @id", async () => {
      await expect(engine().evaluate(readPatient(clinicianA, PT_1001))).resolves.toEqual({
        allow: true,
        reason: "Permitted by hospital.read-patient.assigned-clinician"
      });
    });

    it("denies another clinician's patient and a type-level request, but lets an admin ask about every instance", async () => {
      const e = engine();
      expect((await e.evaluate(readPatient(clinicianA, { ...PT_1001, assignedClinicianId: "PR-2002" }))).allow).toBe(false);
      expect((await e.evaluate(readPatient(clinicianA))).allow).toBe(false);
      expect((await e.evaluate(readPatient(admin))).allow).toBe(true);
    });

    it("a subject's roles are its Cedar group memberships", async () => {
      const e = engine();
      const aircraft = (subject: Identity, policyName: string): PolicyRequest => ({ subject, action: "read", policyName, resource: { typeName: "airforce.Aircraft" } });
      const viewer: Identity = { subjectId: "v", roles: ["viewer"], attributes: {} };
      expect((await e.evaluate(aircraft(viewer, "airforce.read-aircraft"))).allow).toBe(true);
      expect((await e.evaluate(aircraft(viewer, "airforce.maintainer-only"))).allow).toBe(false);
      expect((await e.evaluate(aircraft({ ...viewer, roles: ["viewer", "maintainer"] }, "airforce.maintainer-only"))).allow).toBe(true);
    });
  });

  describe("only schema-declared, Cedar-safe attributes reach a policy", () => {
    it("drops undeclared attributes — PHI on the resource, extra token claims on the subject — instead of failing on them", async () => {
      const tokenClinician: Identity = {
        ...clinicianA,
        attributes: { providerId: "PR-2001", iss: "https://idp.example", aud: ["typesys"], exp: 1790000000, scope: "read", nested: { a: 1 } }
      };
      await expect(engine().evaluate(readPatient(tokenClinician, PT_1001))).resolves.toMatchObject({ allow: true });

      // What the engine protects against: Cedar itself rejects an entity carrying an undeclared attribute.
      const raw = isAuthorized({
        principal: { type: "TypeS::User", id: "u" },
        action: { type: "TypeS::Action", id: "hospital.read-patient" },
        resource: { type: "hospital::Patient", id: "PT-1001" },
        context: {},
        schema: SCHEMA,
        validateRequest: true,
        policies: { staticPolicies: POLICIES },
        entities: [
          { uid: { type: "TypeS::User", id: "u" }, attrs: {}, parents: [] },
          { uid: { type: "hospital::Patient", id: "PT-1001" }, attrs: { name: "Jordan Lee" }, parents: [] }
        ]
      });
      expect(raw.type).toBe("failure");
    });

    it("a declared attribute of the wrong type or shape fails the whole request closed, and says why to onError", async () => {
      const errors: CedarErrorDetail[] = [];
      const e = engine({}, errors);
      const provider = (subject: Identity): PolicyRequest => ({ subject, action: "read", policyName: "hospital.read-provider", resource: { typeName: "hospital.Provider" } });
      const forged: unknown[] = [["PR-2001"], 2001, 2001.5, Number.NaN, { __entity: { type: "TypeS::User", id: "PR-2001" } }, { toString: () => "PR-2001" }];
      for (const providerId of forged) {
        const subject: Identity = { ...clinicianA, attributes: { providerId } };
        expect((await e.evaluate(readPatient(subject, PT_1001))).allow).toBe(false);
        // The whole request, not just the rule reading it: even the public directory is refused.
        expect((await e.evaluate(provider(subject))).allow).toBe(false);
      }
      expect(errors).toHaveLength(forged.length * 2);
      const forgedResource = { ...PT_1001, assignedClinicianId: { __entity: { type: "TypeS::User", id: "user-clinician-1" } } };
      expect((await e.evaluate(readPatient(clinicianA, forgedResource))).allow).toBe(false);
    });

    it("null is absent, not an error: the rule reading it doesn't match, and nothing else is affected", async () => {
      const e = engine();
      const subject: Identity = { ...clinicianA, attributes: { providerId: null } };
      expect((await e.evaluate(readPatient(subject, PT_1001))).allow).toBe(false);
      expect((await e.evaluate({ subject, action: "read", policyName: "hospital.read-provider", resource: { typeName: "hospital.Provider" } })).allow).toBe(true);
    });

    it("a wrong-typed value cannot silently disable a forbid — the reason it's refused rather than dropped", async () => {
      const schema = SCHEMA.replace("assignedClinicianId?: String", "assignedClinicianId?: String, classification?: String");
      const policies = `${POLICIES}
@id("forbid-secret") forbid (principal, action == TypeS::Action::"hospital.read-patient", resource) when { resource has classification && resource.classification == "secret" };`;
      const e = engine({ schema, policies });
      const as = (classification: unknown) => e.evaluate(readPatient(admin, { id: "PT-9", classification }, "PT-9"));
      expect((await as("secret")).reason).toBe("Forbidden by forbid-secret");
      expect((await as(7)).allow).toBe(false); // dropped, it would have allowed
      expect((await as(["secret"])).allow).toBe(false);
      expect((await as("public")).allow).toBe(true);
      // Documented: null reads as absent, so a forbid that must also cover missing values needs its own clause.
      expect((await as(null)).allow).toBe(true);
    });

    it("reads only own properties, never inherited ones", async () => {
      const request = readPatient(clinicianA, {});
      request.resource.attributes = Object.create({ id: "PT-1001", assignedClinicianId: "PR-2001" }) as Record<string, unknown>;
      expect((await engine().evaluate(request)).allow).toBe(false);
    });
  });

  describe("load time: an untrustworthy policy set is never built", () => {
    const loads = (overrides: { schema?: string; policies?: string }) => () => engine(overrides);

    it("rejects a policy set that doesn't parse", () => {
      expect(loads({ policies: `permit (principal, action, resource` })).toThrow(CedarPolicyError);
    });

    it("rejects a policy that reads an undeclared attribute", () => {
      const policies = `permit (principal, action == TypeS::Action::"hospital.read-patient", resource) when { resource.name == "x" };`;
      expect(loads({ policies })).toThrow(/attribute `name` on entity type `hospital::Patient` not found/);
    });

    it("rejects an impossible policy — a typo'd attribute behind `has`, which in a forbid would silently never fire", () => {
      const policies = `${POLICIES}\n@id("typo") forbid (principal, action == TypeS::Action::"hospital.read-patient", resource) when { resource has asignedClinicianId };`;
      expect(loads({ policies })).toThrow(/typo: .*policy is impossible/);
    });

    it("rejects a policy that reads an optional attribute without a `has` guard — the type-level contract, checked statically", () => {
      const policies = `permit (principal, action == TypeS::Action::"hospital.read-patient", resource) when { resource.assignedClinicianId == principal.providerId };`;
      expect(loads({ policies })).toThrow(/optional attribute/);
    });

    it("rejects a schema that doesn't parse", () => {
      expect(loads({ schema: "namespace TypeS { entity" })).toThrow(CedarPolicyError);
    });

    it("rejects a required resource attribute, which every type-level request would lack", () => {
      const schema = SCHEMA.replace("assignedClinicianId?: String", "assignedClinicianId: String");
      expect(loads({ schema })).toThrow(/hospital::Patient\.assignedClinicianId must be optional/);
    });

    it("rejects a schema without the identity model the mapping relies on", () => {
      expect(loads({ schema: SCHEMA.replace("entity Role;", "").replace("entity User in [Role]", "entity User") })).toThrow(/TypeS::Role/);
      expect(loads({ schema: SCHEMA.replace("entity User in [Role]", "entity User") })).toThrow(/in \[Role\]/);
    });

    it("rejects two policies sharing an @id, and policy templates", () => {
      expect(loads({ policies: `${POLICIES}\n@id("hospital.staff-only") permit (principal, action, resource);` })).toThrow(/share the id/);
      expect(loads({ policies: `${POLICIES}\npermit (principal == ?principal, action, resource);` })).toThrow(/templates/);
    });
  });

  describe("request time: fails closed on any Cedar error", () => {
    const LEVELLED = SCHEMA.replace("assignedClinicianId?: String", "assignedClinicianId?: String, level?: Long");
    const ERRORING_FORBID = `${POLICIES}
@id("forbid-high-level")
forbid (principal, action == TypeS::Action::"hospital.read-patient", resource) when { resource has level && resource.level * 9223372036854775807 > 0 };`;

    it("an erroring forbid can't fall through to a matching permit", async () => {
      const errors: CedarErrorDetail[] = [];
      const e = engine({ schema: LEVELLED, policies: ERRORING_FORBID }, errors);
      const decision = await e.evaluate(readPatient(admin, { id: "PT-9", level: 2 }, "PT-9"));

      expect(decision.allow).toBe(false);
      expect(decision.reason).toBe("Cedar policy forbid-high-level errored (fail closed)");
      // Which policy errored is a fault an operator sees (ADR-0043); Cedar's own message stays out of it.
      expect(decision.faults).toEqual(["Cedar policy forbid-high-level errored"]);
      expect(errors).toEqual([{ policyName: "hospital.read-patient", messages: [expect.stringContaining("overflow") as string] }]);

      // The trap: Cedar alone skips the erroring forbid and allows.
      const raw = isAuthorized({
        principal: { type: "TypeS::User", id: "a" },
        action: { type: "TypeS::Action", id: "hospital.read-patient" },
        resource: { type: "hospital::Patient", id: "PT-9" },
        context: {},
        schema: LEVELLED,
        validateRequest: true,
        policies: { staticPolicies: ERRORING_FORBID },
        entities: [
          { uid: { type: "TypeS::User", id: "a" }, attrs: {}, parents: [{ type: "TypeS::Role", id: "admin" }] },
          { uid: { type: "TypeS::Role", id: "admin" }, attrs: {}, parents: [] },
          { uid: { type: "hospital::Patient", id: "PT-9" }, attrs: { level: 2 }, parents: [] }
        ]
      });
      expect(raw.type === "success" && raw.response.decision).toBe("allow");
    });

    it("a stored value of the wrong type denies, and its detail goes to onError, not the reason", async () => {
      const errors: CedarErrorDetail[] = [];
      const decision = await engine({}, errors).evaluate(readPatient(clinicianA, { ...PT_1001, assignedClinicianId: 2001 }));
      expect(decision).toEqual({ allow: false, reason: 'Cedar rejected the request for "hospital.read-patient" (fail closed)' });
      expect(errors[0]!.messages.join(" ")).toMatch(/type mismatch/);
    });

    it("an undeclared policy name or resource type denies", async () => {
      const e = engine();
      expect((await e.evaluate({ ...readPatient(admin), policyName: "default-deny" })).allow).toBe(false);
      expect((await e.evaluate({ ...readPatient(admin), resource: { typeName: "core.Person" } })).allow).toBe(false);
      expect((await e.evaluate({ ...readPatient(admin), resource: { typeName: "not a type!" } })).allow).toBe(false);
    });

    it("malformed request shapes deny rather than throw", async () => {
      const e = engine();
      const odd = { subjectId: 42, roles: [null, "admin"], attributes: null } as unknown as Identity;
      await expect(e.evaluate(readPatient(odd, PT_1001))).resolves.toMatchObject({ allow: false });
    });

    it("no reason ever carries an attribute value", async () => {
      const e = engine({ schema: LEVELLED, policies: ERRORING_FORBID });
      const reasons = await Promise.all([
        e.evaluate(readPatient(clinicianA, { ...PT_1001, assignedClinicianId: "PR-SECRET" })),
        e.evaluate(readPatient(clinicianA, { ...PT_1001, assignedClinicianId: 7777 })),
        e.evaluate(readPatient(admin, { id: "PT-SECRET", level: 3 }, "PT-9"))
      ]);
      const text = JSON.stringify(reasons);
      for (const secret of ["PR-SECRET", "7777", "PT-SECRET", "Jordan Lee", "MRN-1001"]) expect(text).not.toContain(secret);
    });
  });

  it("engines keep their own policy sets — preparsed state is never shared", async () => {
    const open = engine({ policies: `permit (principal, action == TypeS::Action::"hospital.read-provider", resource);` });
    const closed = engine({ policies: `forbid (principal, action == TypeS::Action::"hospital.read-provider", resource);` });
    const request: PolicyRequest = { subject: admin, action: "read", policyName: "hospital.read-provider", resource: { typeName: "hospital.Provider" } };
    expect((await open.evaluate(request)).allow).toBe(true);
    expect((await closed.evaluate(request)).allow).toBe(false);
    expect((await open.evaluate(request)).allow).toBe(true);
  });
});
