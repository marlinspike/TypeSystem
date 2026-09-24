# Developer Guide: Adding a New Domain

This walks through adding an entirely new domain — **Hospital** (`Patient`,
`Provider`, `Appointment`) — to prove the architecture is genuinely
domain-neutral (ADR-0013). It follows the exact authoring pattern already
used by `packages/domain-airforce`, and the one hard rule is:

> You may add a new `packages/domain-hospital/` directory. You must **not**
> touch anything under `packages/core/src`.

If you find yourself wanting to edit `packages/core`, that's a signal the
change belongs in your domain package, or in a shared trait, not in core.

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
    "@typesys/core": "0.1.0"
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
import { PATIENT_DATA_SOURCE_ID } from "./patient.js";

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
        resolution: { dataSourceId: PATIENT_DATA_SOURCE_ID, operation: "byId:patientId" }
      },
      provider: {
        target: "hospital.Provider",
        cardinality: "one-to-one",
        description: "The clinician this appointment is with.",
        resolution: { dataSourceId: PATIENT_DATA_SOURCE_ID, operation: "byId:providerId" }
      }
    },
    "x-policy": { objectPolicy: "hospital.read-appointment" }
  },
  options: { name: "hospital.Appointment", version: "1.0.0" }
};
```

Note: `operation: "byId:<field>"` above is illustrative of the relationship
resolution shape — `InMemoryRepositoryAdapter`'s built-in
`resolveRelationship()` in this codebase only understands
`"byForeignKey:<field>"` (matching *many* records whose `<field>` equals the
source object's id, e.g. `Aircraft.components`). A one-to-one "look up a
single record by its own id" relationship like `Appointment -> Patient`
would need either a small adapter-side addition to interpret a
`"byId:<field>"` operation, or could reuse `byForeignKey` if you model it as
"find all Patients whose `id` equals this Appointment's `patientId`" (which
also works for cardinality `one-to-one`, since exactly one match is
expected). Either way, this is an adapter-level detail — it does not
require touching `packages/core`.

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
  both files are generic over whatever the registry holds.

## 5. What you don't need to build for this to be architecturally valid

Real `DataSource` + `Mapping` + `Adapter` wiring (like
`airforceDataSources`/`airforceMappings` and the in-memory/mock-REST
adapters in `packages/domain-airforce`) is what you'd need before an
`Appointment` object could actually be resolved with real data. It is
**not required** to prove the point this walkthrough is making. The point
is that the registry, runtime, and MCP layers needed zero code changes to
accept a brand-new domain — the same guarantee `packages/domain-airforce`
relies on, generalized to a second, unrelated domain. If you do want to run
it end-to-end, `packages/adapter-in-memory`'s `InMemoryRepositoryAdapter`
is directly reusable: seed it with sample Patients/Providers/Appointments
the same way `packages/domain-airforce/src/setup.ts` seeds Aircraft and
Component data, and register a matching `DataSource` + wildcard `Mapping`
set the same way `packages/domain-airforce/src/mappings/index.ts` does.

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
