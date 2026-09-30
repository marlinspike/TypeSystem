// The demo domains' rules (`airforcePolicyRules`, `hospitalPolicyRules`) as a
// Cedar policy set (ADR-0031), including ADR-0030's own-patient rule. Each
// TypeS policy name is one Cedar action; `@id` names the policy in decisions
// and audit reasons. Proven to decide identically to the AbacPolicyEngine
// rules by packages/policy-cedar/test/parity.test.ts.

// ---- Air Force -------------------------------------------------------------

@id("airforce.read-aircraft")
permit (principal, action == TypeS::Action::"airforce.read-aircraft", resource)
when { principal in [TypeS::Role::"maintainer", TypeS::Role::"viewer"] };

@id("airforce.maintainer-only")
permit (principal in TypeS::Role::"maintainer", action == TypeS::Action::"airforce.maintainer-only", resource);

// ---- Hospital --------------------------------------------------------------

// The provider directory is not sensitive: anyone may browse it.
@id("hospital.read-provider")
permit (principal, action == TypeS::Action::"hospital.read-provider", resource);

// Per-instance (ADR-0030): an admin reads every Patient...
@id("hospital.read-patient.admin")
permit (principal in TypeS::Role::"admin", action == TypeS::Action::"hospital.read-patient", resource);

// ...a clinician only the patients assigned to them...
@id("hospital.read-patient.assigned-clinician")
permit (principal in TypeS::Role::"clinician", action == TypeS::Action::"hospital.read-patient", resource)
when {
  resource has assignedClinicianId && principal has providerId &&
  resource.assignedClinicianId != "" && resource.assignedClinicianId == principal.providerId
};

// ...and a patient only their own record.
@id("hospital.read-patient.own-record")
permit (principal in TypeS::Role::"patient", action == TypeS::Action::"hospital.read-patient", resource)
when {
  resource has id && principal has patientId &&
  resource.id != "" && resource.id == principal.patientId
};

@id("hospital.read-appointment")
permit (principal, action == TypeS::Action::"hospital.read-appointment", resource)
when { principal in [TypeS::Role::"clinician", TypeS::Role::"admin", TypeS::Role::"patient"] };

@id("hospital.staff-only")
permit (principal, action == TypeS::Action::"hospital.staff-only", resource)
when { principal in [TypeS::Role::"clinician", TypeS::Role::"admin"] };
