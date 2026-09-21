# Mission: Build a Modern Enterprise Semantic Type System

I want you to act as the senior architect and implementation lead for a new foundational platform capability: a **modern, open, extensible enterprise Type System and Semantic Model**.

The conceptual inspiration is the best part of systems such as the C3 AI Type System and Palantir Ontology, but **do not clone either system** and do not reproduce their proprietary architecture.

Instead, ask:

> If we were inventing this architecture today, using modern open standards, JSON Schema, APIs, graphs, MCP, policy engines, event-driven systems, and AI agents, what should it look like?

The resulting platform should be capable of supporting highly complex Department of Defense and Federal environments, but the core architecture must remain **domain-neutral** so it can eventually support commercial enterprises as well.

Do not build a "DoD Type System."

Build a **general semantic runtime** that can be extended with DoD, Federal, healthcare, manufacturing, financial, logistics, or other domain models.

---

# The fundamental problem

Large enterprises have hundreds or thousands of disconnected systems:

* databases
* APIs
* SaaS applications
* data lakes
* event streams
* files
* legacy systems
* ERP systems
* operational systems
* ML models
* external services

Applications and AI agents should not need to understand all of those physical implementations.

For example, an Air Force application or agent should be able to reason about:

```text
Aircraft
Component
Mission
MaintenanceEvent
WorkOrder
Person
Organization
Location
SupplyItem
```

rather than having to understand the schemas and APIs of REMIS, IMDS, SAP, Oracle, Snowflake, Databricks, etc.

Likewise, a commercial system might model:

```text
Customer
Product
Order
Facility
Employee
Contract
Invoice
Asset
```

The platform therefore needs a canonical semantic layer between physical enterprise systems and consumers.

Conceptually:

```text
                  Applications
                       │
                  AI / Agents
                       │
                       ▼
        ┌────────────────────────────┐
        │   SEMANTIC RUNTIME         │
        │                            │
        │ Objects / Types            │
        │ Relationships              │
        │ Actions                    │
        │ Policies                   │
        │ Computed properties        │
        │ Provenance                 │
        │ Events                     │
        │ Metadata                   │
        └─────────────┬──────────────┘
                      │
               Adapter / Mapping Layer
                      │
       ┌──────────────┼───────────────┐
       ▼              ▼               ▼
    Databases        APIs          Events
       │              │               │
       └────── Enterprise Systems ────┘
```

The semantic model becomes the stable contract.

---

# Core design principle

Separate:

**what something IS**

from

**where its data comes from**

from

**what can be DONE to it**.

For example:

```text
Aircraft
    id
    tailNumber
    model
    status

    relationships:
        components
        missions
        maintenanceEvents
```

should be independent from:

```text
Aircraft.status
    source: REMIS
```

and independent from:

```text
Action:
    CreateMaintenanceWorkOrder
```

The semantic definition must not be coupled to a specific database, cloud provider, transport protocol, or AI framework.

---

# Standards-first

Avoid inventing proprietary languages or protocols unless there is a compelling technical reason.

Prefer established standards and portable representations.

Strongly consider:

* JSON Schema 2020-12 as the foundational structural schema representation
* JSON / JSON-LD where appropriate
* OpenAPI
* MCP
* OAuth/OIDC
* OpenTelemetry
* standard event formats where useful
* SQL/PostgreSQL for durable metadata where appropriate
* graph semantics where relationships justify them
* policy-as-code for authorization/governance

However, do not blindly use a technology simply because I listed it.

Evaluate alternatives and make architectural decisions.

The architecture should make it possible to replace individual infrastructure components without changing the semantic model.

---

# Semantic model

The system should support first-class definitions for at least:

```text
Type
Property
Relationship
Action
ComputedProperty
Policy
Event
DataSource
Mapping
```

A Type should support concepts such as:

```text
identity
name
description
version

properties
relationships

actions

computed properties

validation

security / policies

provenance

metadata
```

For example:

```text
Aircraft
 ├── tailNumber
 ├── model
 ├── status
 │
 ├── components ─────────► Component
 ├── missions ───────────► Mission
 ├── maintenanceEvents ──► MaintenanceEvent
 │
 ├── readinessScore
 │
 └── actions
       ├── createWorkOrder
       ├── scheduleMaintenance
       └── assignMission
```

Relationships must be first-class objects, not merely nested JSON.

Support:

```text
one-to-one
one-to-many
many-to-many
```

and relationships carrying their own metadata when appropriate.

---

# Type composition

Do not force everything into classical inheritance.

Evaluate and support appropriate mechanisms such as:

* composition
* interfaces
* traits/capabilities
* schema references
* reusable property groups

For example:

```text
Asset
  ├── Aircraft
  ├── Vehicle
  └── Facility

Trackable
Maintainable
Ownable
Geolocatable
```

An Aircraft might therefore be:

```text
Aircraft
  extends Asset

  implements:
    Trackable
    Maintainable
```

Design this carefully so we don't recreate the complexity of old object-oriented inheritance systems.

---

# Actions are first-class

Do not put all behavior directly onto Types.

Separate semantic objects from governed capabilities.

Example:

```text
Aircraft
```

is a semantic object.

Whereas:

```text
CreateWorkOrder
AssignMission
ScheduleMaintenance
GroundAircraft
```

are Actions.

An Action should describe things such as:

```text
name
description

input schema
output schema

applicable types

authorization policy

preconditions

implementation binding

side effects

audit requirements

idempotency characteristics
```

An Action might ultimately be implemented by:

```text
REST API
database transaction
workflow
serverless function
message
MCP tool
legacy system adapter
```

The semantic layer should not care.

---

# AI / Agent architecture

AI is a first-class consumer, but the Type System must **not depend on AI**.

Agents should be able to discover:

```text
What objects exist?
What properties do they have?
How are they related?
What actions are available?
What actions am I authorized to perform?
Where did this information come from?
How fresh is it?
```

Expose the semantic model through MCP.

Think carefully about the mapping:

```text
Semantic Types       → MCP resources/context
Relationships        → navigable semantic context
Actions              → MCP tools
Schemas              → JSON Schema
Authorization        → tool/action enforcement
```

Do not expose every backend operation directly to an LLM.

The semantic runtime must remain the policy and governance boundary.

The architecture should support both:

```text
Human → Application → Semantic Runtime
```

and:

```text
AI Agent → MCP → Semantic Runtime
```

with equivalent security and governance.

---

# Provenance is critical

Federal and DoD users need to know where information came from.

Every resolved property should be capable of carrying provenance such as:

```text
value: "NMC"

source:
    system: REMIS
    record: ...
    field: ...

observedAt:
retrievedAt:
confidence:
classification:
```

Do not assume every property requires all of this metadata physically attached to every returned JSON object. Design an efficient provenance model.

But provenance must be a first-class architectural capability.

---

# Multiple sources of truth

A semantic object may be assembled from multiple systems.

Example:

```text
Aircraft

tailNumber      ← IMDS
location        ← operational telemetry
maintenance     ← REMIS
supplyStatus    ← ERP
mission         ← mission planning system
```

Design an explicit mechanism for source priority, authority, conflict resolution, freshness, and fallback.

Do not hide these rules in arbitrary application code.

---

# Security

Treat security as foundational.

Eventually this may operate in:

```text
Commercial
FedRAMP
DoD IL4
DoD IL5
DoD IL6
classified environments
```

Do not attempt to "implement IL6 compliance."

Instead, ensure the architecture does not make those environments impossible.

Design for:

* least privilege
* RBAC
* ABAC
* object-level authorization
* property-level authorization where necessary
* action authorization
* tenant isolation
* auditing
* provenance
* immutable security events
* classification / handling metadata
* policy enforcement independent from UI
* identity propagation
* zero-trust assumptions

A user being able to retrieve an Aircraft does not automatically mean they can retrieve every property of that Aircraft or invoke every Action on it.

---

# Data architecture

Do not make the Semantic Runtime another giant enterprise database.

Support multiple operating modes:

```text
virtualized
materialized
hybrid
```

For some properties:

```text
Semantic Runtime → live source API
```

For others:

```text
Source → ingest → canonical store → Semantic Runtime
```

For others:

```text
Source event → projection/materialized view
```

The semantic definition must remain independent of the physical strategy.

---

# Events and change propagation

Think beyond CRUD.

The architecture should eventually support:

```text
Aircraft.engineHours changed
        │
        ▼
FailureRisk stale
        │
        ▼
recompute
        │
        ▼
Readiness changed
        │
        ▼
MissionPlanning affected
```

Do NOT attempt to build a gigantic reactive DAG engine in the first iteration.

But establish clean architectural seams for:

* events
* invalidation
* computed values
* dependency tracking
* asynchronous workflows
* eventual consistency

---

# Schema evolution

This is extremely important.

Enterprise semantic models will evolve for years.

Design explicit support for:

```text
versioning
backward compatibility
deprecation
migration
aliases
schema evolution
relationship evolution
action evolution
```

Existing consumers must not silently break because someone adds or modifies a semantic definition.

Think carefully about stable IDs versus display names.

---

# Domain packages

The core must know nothing about aircraft.

Domain models should be installable packages/modules.

For example:

```text
/core
    Party
    Person
    Organization
    Location
    Asset
    Event

/domains/dod
    Mission
    Unit

/domains/airforce
    Aircraft
    Sortie
    MaintenanceEvent

/domains/logistics
    SupplyItem
    Shipment
    Warehouse

/domains/commercial
    Customer
    Product
    Order
```

A customer should be able to create:

```text
/customers/acme
/customers/usaf
/customers/hhs
```

without modifying the runtime.

Design domain extension as a first-class capability.

---

# Developer experience

This system will fail if defining Types becomes painful.

A developer should ideally be able to create something roughly as simple as:

```yaml
name: Aircraft
version: 1.0

properties:
  tailNumber:
    type: string
    required: true

  status:
    $ref: AircraftStatus

relationships:
  components:
    target: Component
    cardinality: many

actions:
  - CreateWorkOrder
```

That is illustrative, not a required syntax.

Determine whether JSON, YAML, TypeScript, JSON Schema extensions, or another representation provides the best authoring experience.

The canonical representation should remain machine-readable and standards-based.

Consider generating:

```text
JSON Schema
TypeScript types
Python models
OpenAPI
MCP schemas
documentation
```

from the semantic model where useful.

Avoid unnecessary code generation if runtime interpretation is cleaner.

---

# Querying

Consumers need a clean semantic query mechanism.

Examples:

```text
Get Aircraft AF86-0147

Get its components.

Get maintenance events from the last 90 days.

Get the source/provenance for readiness status.

Find aircraft where:

status = NMC
AND base = Langley
AND predictedFailureRisk > .8
```

Do not invent a massive proprietary query language prematurely.

Evaluate whether existing standards, structured JSON queries, GraphQL, REST patterns, or another approach can provide this.

The semantic API should prevent consumers from needing to know where the underlying data resides.

---

# Architecture boundaries

Keep these concepts separate:

```text
Semantic Model
       │
       ▼
Semantic Registry
       │
       ▼
Semantic Runtime
       │
 ┌─────┴───────┐
 ▼             ▼
Query        Actions
 │             │
 ▼             ▼
Adapters     Executors
 │             │
 └──────┬──────┘
        ▼
 Enterprise Systems
```

And independently:

```text
             Policy Engine
                  │
        ┌─────────┼─────────┐
        ▼         ▼         ▼
      Query     Action     MCP
```

Do not collapse all of this into one service or giant abstraction.

---

# Example vertical slice

Use a small but meaningful example to prove the architecture.

Create a sample domain containing approximately:

```text
Aircraft
Component
MaintenanceEvent
WorkOrder
```

Relationships:

```text
Aircraft
   │
   ├── components ─────► Component
   │
   └── maintenance ────► MaintenanceEvent
                              │
                              └── workOrder ──► WorkOrder
```

Provide at least one computed property:

```text
Aircraft.readinessStatus
```

and at least one Action:

```text
CreateMaintenanceWorkOrder
```

Use fake/sample data only.

Demonstrate that the same semantic objects can be backed by at least two different adapter styles without changing the consumer-facing model.

For example:

```text
Aircraft → PostgreSQL/in-memory repository
MaintenanceEvent → mocked external REST adapter
```

The exact choices are yours.

---

# MCP demonstration

Expose enough through MCP to demonstrate that an AI agent could:

1. discover an Aircraft
2. inspect its semantic definition
3. retrieve the Aircraft
4. navigate to its components or maintenance history
5. understand provenance
6. discover available Actions
7. invoke an authorized test Action

Do not build an AI chatbot.

The MCP surface itself is the proof.

---

# Non-goals for the first implementation

Do not try to build:

* an enterprise data lake
* a complete graph database
* a workflow engine
* an ETL platform
* a Kafka replacement
* an IAM system
* a full policy engine
* a proprietary programming language
* an LLM orchestration framework
* a UI platform
* a C3 clone
* a Palantir clone

Integrate or establish interfaces for those capabilities instead.

The first implementation should prove that the semantic abstraction is correct.

---

# Quality bar

This is foundational architecture, not a prototype that we intend to throw away.

Optimize for:

```text
simplicity
extensibility
open standards
strong contracts
clear boundaries
testability
security
observability
portability
developer ergonomics
```

Avoid speculative abstraction.

If an abstraction is not needed by the vertical slice but clearly belongs in the architecture, document the extension point rather than building an elaborate implementation.

---

# Before coding

First inspect the repository and understand the existing architecture, conventions, languages, test framework, deployment model, and dependencies.

Then research current authoritative specifications where relevant, especially:

* JSON Schema
* MCP
* OpenAPI
* OAuth/OIDC
* OpenTelemetry

Do not rely on assumptions about current protocol versions.

Then produce an architecture proposal.

I want you to explicitly reason through major choices including:

* canonical schema representation
* Type identity
* relationships
* composition vs inheritance
* Actions
* adapter architecture
* runtime resolution
* provenance
* security/policy boundaries
* schema versioning
* query model
* MCP mapping
* domain packaging
* persistence of semantic metadata

For significant decisions, explain alternatives considered and why you chose the proposed design.

---

# Challenge the premise

Do not assume everything above is correct.

If part of this design recreates functionality already solved better by a mature open standard or project, tell me.

If JSON Schema is insufficient for part of the semantic model, explain exactly why.

If MCP is the wrong abstraction for part of the runtime, don't force it.

If a graph database is unnecessary, don't add one.

If an RDF/OWL-style ontology would provide meaningful capabilities that this design lacks, evaluate that.

If GraphQL would materially improve the query model, evaluate it.

The goal is not to implement my preconceived architecture.

The goal is to build the **simplest architecture capable of becoming a serious enterprise semantic runtime.**

---

# Deliverables

Start by producing:

**1. Architecture**

A clear architecture document explaining the system, major components, data flow, security boundaries, extension model, and important design decisions.

Include Mermaid diagrams.

**2. ADRs**

Create ADRs for major irreversible or expensive decisions.

Do not create ADRs for trivial implementation choices.

**3. Semantic specification**

Define the canonical semantic meta-model:

```text
Type
Property
Relationship
Action
Policy
DataSource
Mapping
ComputedProperty
Event
```

and explain their contracts.

**4. Working vertical slice**

Implement the Aircraft/Component/MaintenanceEvent/WorkOrder example end-to-end.

**5. MCP interface**

Provide a working MCP server exposing the semantic model and governed Actions.

**6. Tests**

Include strong tests for:

* schema validation
* relationships
* adapter substitution
* provenance
* authorization boundaries
* Action validation
* schema compatibility/versioning
* MCP contracts

**7. Developer documentation**

Show how another developer can create an entirely new domain without modifying the semantic runtime.

For example:

```text
Hospital
Patient
Provider
Appointment
```

or:

```text
Factory
Machine
Part
WorkOrder
```

The example should demonstrate that the architecture is genuinely domain-neutral.

---

# Most important architectural invariant

A consumer should be able to say:

> Give me Aircraft AF86-0147, its components, its readiness, its provenance, and the actions I am permitted to perform.

without knowing:

* what database contains it
* which API owns it
* which cloud it runs in
* how many source systems contributed to it
* how those systems represent an aircraft
* how the underlying action is executed

That separation is the heart of the platform.

Build toward that invariant.

---

# Execution approach

Do not attempt to implement the entire vision in one giant pass.

Treat this as a platform that could live for a decade.

Start with architecture and the semantic meta-model. Identify what must exist now versus what should remain an extension point.

Then build the smallest coherent vertical slice that proves the architecture.

Before making large or difficult-to-reverse architectural decisions, surface them to me with your recommendation and reasoning.

Once the architecture is agreed, own the implementation as the senior engineer: make sensible implementation decisions, maintain coherence across the system, test aggressively, and avoid unnecessary complexity.

The outcome I want is not "a demo of some JSON schemas."

I want the beginnings of a **universal semantic layer for enterprise software and AI**.
