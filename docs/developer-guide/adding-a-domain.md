# Developer Guide: Adding a New Domain

This walks through adding an entirely new domain — **Hospital** (`Patient`,
`Provider`, `Appointment`) — to prove the architecture is genuinely
domain-neutral (ADR-0013). It follows the exact authoring pattern already
used by `packages/domain-airforce`, and the one hard rule is:

> You may add a new `packages/domain-hospital/` directory. You must **not**
> touch anything under `packages/core/src`.

If you find yourself wanting to edit `packages/core`, that's a signal the
change belongs in your domain package, or in a shared trait, not in core.

**This is now real, tested code, not just a walkthrough.**
[`packages/domain-hospital`](../../packages/domain-hospital) is exactly
what's described below, built and passing 15 tests — relationship
resolution for both adapter conventions (`byForeignKey`/`byOwnField`),
`extends core.Person` composition, object- and property-level policy
boundaries, and a real MCP-protocol proof
(`test/mcp-domain-neutrality.test.ts`) that `packages/mcp-server`'s
`resources.ts`/`tools.ts` browse this domain correctly with zero changes
to either file. Read the steps below for the *why* behind each piece,
then read the actual package for the *exactly how* — they match.

## 1. Lay out the package

Following `packages/domain-airforce`'s shape:

```text
packages/domain-hospital/
  package.json
  src/
    types/
      patient.ts
      provider.ts
      appointment.ts
    manifest.ts
    setup.ts
    index.ts
```

`package.json` mirrors `packages/domain-airforce/package.json` — an npm
workspace package depending on `@typesys/core` (and, if you wire up real
adapters, `@typesys/adapter-in-memory`/`@typesys/adapter-mock-rest` or your
own):

```json
{
  "name": "@typesys/domain-hospital",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": "./dist/index.js" },
  "dependencies": {
    "@typesys/core": "0.1.0",
    "@typesys/adapter-in-memory": "0.1.0"
  }
}
```

## 2. Author the Types

Each Type is a `DomainTypeEntry` (`{schema, options}`), exactly as in
`packages/domain-airforce/src/types/aircraft.ts`.

**`Patient`** extends `core.Person` (from `packages/core`) rather than
redefining name/contact fields from scratch — `core.Person` already
contributes `email`, `roleTitle`, and an `affiliations` relationship to
`core.Organization` via `core.Party`:

```ts
// packages/domain-hospital/src/types/patient.ts
import type { DomainTypeEntry } from "@typesys/core";

export const PATIENT_DATA_SOURCE_ID = "in-memory-hospital-repo";

export const PatientType: DomainTypeEntry = {
  schema: {
    $id: "https://typesys.dev/types/hospital/Patient/1.0.0",
    title: "Patient",
    description: "A person receiving care at this hospital.",
    type: "object",
    properties: {
      medicalRecordNumber: { type: "string" },
      dateOfBirth: { type: "string", format: "date" }
    },
    required: ["medicalRecordNumber"],
    "x-relationships": {
      appointments: {
        target: "hospital.Appointment",
        cardinality: "one-to-many",
        description: "Appointments scheduled for this patient.",
        resolution: { dataSourceId: PATIENT_DATA_SOURCE_ID, operation: "byForeignKey:patientId" }
      }
    },
    "x-policy": { objectPolicy: "hospital.read-patient" }
  },
  options: {
    name: "hospital.Patient",
    version: "1.0.0",
    extends: "core.Person"
  }
};
```

**`Provider`** is a standalone Type — a clinician, not a subtype of any
core type in this example, though it could equally extend `core.Person` if
you wanted the same `email`/`affiliations` shape:

```ts
// packages/domain-hospital/src/types/provider.ts
import type { DomainTypeEntry } from "@typesys/core";

export const PROVIDER_DATA_SOURCE_ID = "in-memory-hospital-repo";

export const ProviderType: DomainTypeEntry = {
  schema: {
    $id: "https://typesys.dev/types/hospital/Provider/1.0.0",
    title: "Provider",
    description: "A clinician who can be scheduled against an Appointment.",
    type: "object",
    properties: {
      id: { type: "string" },
      displayName: { type: "string" },
      specialty: { type: "string" }
    },
    required: ["id", "displayName"],
    "x-policy": { objectPolicy: "hospital.read-provider" }
  },
  options: { name: "hospital.Provider", version: "1.0.0" }
};
```

**`Appointment`** carries the two relationships this walkthrough needs to
prove — `Appointment -> Patient` and `Appointment -> Provider` — both
`one-to-one` from the Appointment side:

```ts
// packages/domain-hospital/src/types/appointment.ts
import type { DomainTypeEntry } from "@typesys/core";
import { HOSPITAL_DATA_SOURCE_ID } from "./patient.js";

export const AppointmentType: DomainTypeEntry = {
  schema: {
    $id: "https://typesys.dev/types/hospital/Appointment/1.0.0",
    title: "Appointment",
    description: "A scheduled encounter between a Patient and a Provider.",
    type: "object",
    properties: {
      id: { type: "string" },
      patientId: { type: "string" },
      providerId: { type: "string" },
      scheduledAt: { type: "string", format: "date-time" },
      status: { type: "string", enum: ["scheduled", "completed", "cancelled"] }
    },
    required: ["id", "patientId", "providerId", "scheduledAt", "status"],
    "x-relationships": {
      patient: {
        target: "hospital.Patient",
        cardinality: "one-to-one",
        description: "The patient this appointment is for.",
        resolution: { dataSourceId: HOSPITAL_DATA_SOURCE_ID, operation: "byOwnField:patientId" }
      },
      provider: {
        target: "hospital.Provider",
        cardinality: "one-to-one",
        description: "The clinician this appointment is with.",
        resolution: { dataSourceId: HOSPITAL_DATA_SOURCE_ID, operation: "byOwnField:providerId" }
      }
    },
    "x-policy": { objectPolicy: "hospital.read-appointment" }
  },
  options: { name: "hospital.Appointment", version: "1.0.0" }
};
```

Note: `operation: "byOwnField:<field>"` is a real, tested relationship
convention — a one-to-one "look up a single record by its own field value"
lookup, the counterpart to `"byForeignKey:<field>"` (which matches *many*
records whose `<field>` equals the source object's id, e.g.
`Aircraft.components` or `Patient.appointments`/`Provider.appointments`
above). It didn't exist in `InMemoryRepositoryAdapter` until this domain
needed it — added there (and, earlier, to `@typesys/adapter-postgres`,
which needed the identical convention for its own one-to-one
relationships) as a small, adapter-level addition. This is exactly the
kind of change this guide's hard rule allows: it lives in
`packages/adapter-in-memory/src/in-memory-repository-adapter.ts`, not
`packages/core/src`.

## 3. Wire the manifest

Following `packages/domain-airforce/src/manifest.ts`:

```ts
// packages/domain-hospital/src/manifest.ts
import type { DomainManifest } from "@typesys/core";
import { PatientType } from "./types/patient.js";
import { ProviderType } from "./types/provider.js";
import { AppointmentType } from "./types/appointment.js";

export const hospitalManifest: DomainManifest = {
  domain: "hospital",
  // Patient extends core.Person, which is already registered by
  // coreManifest; Provider/Appointment don't extend anything, so order
  // among the three doesn't matter beyond Patient needing core.Person
  // registered first (handled by registering coreManifest before this one).
  types: [PatientType, ProviderType, AppointmentType]
  // actions / dataSources / mappings: see step 4.
};
```

## 4. Register it — following `setup.ts`

`packages/domain-airforce/src/setup.ts` shows the pattern for assembling a
fully wired testbed: register `coreManifest`, then the domain's own
manifest, in order:

```ts
// packages/domain-hospital/src/setup.ts
import { SemanticRegistry, InMemoryRegistryStore, registerDomain, coreManifest } from "@typesys/core";
import { hospitalManifest } from "./manifest.js";

export async function buildHospitalRegistry(): Promise<SemanticRegistry> {
  const registry = new SemanticRegistry(new InMemoryRegistryStore());
  await registerDomain(registry, coreManifest);
  await registerDomain(registry, hospitalManifest);
  return registry;
}
```

At this point, with **no changes to `packages/core/src`**, you can already:

- `registry.getType("hospital.Patient")` and see it correctly composed with
  `core.Person` (and, transitively, `core.Party`).
- `registry.listRelationships("hospital.Appointment")` and see `patient`
  and `provider` as first-class `RelationshipDefinition`s.
- Start an `@typesys/mcp-server`-style bootstrap that also registers
  `hospitalManifest`, and immediately browse `hospital.Patient`,
  `hospital.Provider`, and `hospital.Appointment` as MCP resources, with
  zero changes to `packages/mcp-server/src/resources.ts` or `tools.ts` —
  both files are generic over whatever the registry holds. This is not
  hypothetical:
  [`packages/domain-hospital/test/mcp-domain-neutrality.test.ts`](../../packages/domain-hospital/test/mcp-domain-neutrality.test.ts)
  does exactly this over a real MCP `Client`/`Server` connection, calling
  `registerResourceHandlers`/`registerToolHandlers` unmodified.

## 5. Real `DataSource` + `Mapping` + `Adapter` wiring — not strictly required, but built anyway

Real wiring (like `airforceDataSources`/`airforceMappings` and the
in-memory/mock-REST adapters in `packages/domain-airforce`) is what you
need before an `Appointment` object can actually be resolved with real
data. It is **not required** to prove the point this walkthrough is
making — the point is that the registry, runtime, and MCP layers need
zero code changes to accept a brand-new domain — but
`packages/domain-hospital` builds it anyway, so this is a real,
running, tested second domain rather than a registration-only proof:

- `packages/adapter-in-memory`'s `InMemoryRepositoryAdapter`, seeded with
  sample Patients/Providers/Appointments (`src/sample-data/`), the same
  way `packages/domain-airforce/src/setup.ts` seeds Aircraft and
  Component data.
- A matching `DataSource` + wildcard `Mapping` set
  (`src/mappings/index.ts`), the same shape as
  `packages/domain-airforce/src/mappings/index.ts`.
- `buildHospitalTestbed()` (`src/setup.ts`) — the same `buildRuntime`
  helper `buildAirforceTestbed()` calls, proving that helper is generic
  across domains too, not just the registry/runtime/MCP layers.

`packages/domain-hospital/test/relationship-resolution.test.ts` resolves
real `Appointment.patient`/`Appointment.provider`/`Patient.appointments`/
`Provider.appointments` objects end-to-end against this seeded data —
including a `query` with `include` that fans out both relationships for
every Appointment concurrently, the same bounded-concurrency path
(ADR-0019) every other domain's relationships go through.

## 6. Actions, if you need any

`hospital.Appointment` could declare an Action the same way
`airforce.MaintenanceEvent` declares `CreateMaintenanceWorkOrder`
(ADR-0005) — e.g. a `CancelAppointment` Action with
`applicableTypes: ["hospital.Appointment"]`, its own
`authorizationPolicy`, and a precondition checking the appointment isn't
already completed. This is optional for the walkthrough; the Type
model and relationships alone are enough to prove domain-neutrality.

## Summary of what proves the invariant

- `packages/core/src` — untouched.
- A new npm workspace package, `@typesys/domain-hospital`, exports a
  `DomainManifest` in exactly the shape `DomainManifest` requires.
- `Patient extends core.Person` — a domain Type reusing a core base Type,
  exactly like `airforce.Aircraft extends core.Asset`.
- `Appointment -> Patient` and `Appointment -> Provider` are first-class
  `x-relationships`, materialized into independent `RelationshipDefinition`
  records by the same `SemanticRegistry.registerType()` code path every
  other domain uses.
- `registerDomain(registry, hospitalManifest)` is the only call needed to
  bring the whole domain into a running registry/runtime/MCP server.
- `packages/adapter-in-memory/src/in-memory-repository-adapter.ts` gained
  `"byOwnField:<field>"` support — the one real, adapter-level (not core)
  code change this domain needed, adding a second relationship
  convention `Appointment`'s one-to-one relationships use.
- 15 tests, all real, all green: type composition, both relationship
  conventions, object- and property-level policy boundaries, and a real
  MCP-protocol connection proving `resources.ts`/`tools.ts` needed zero
  changes.
