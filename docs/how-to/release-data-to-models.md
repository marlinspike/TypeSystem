# Release data to models

Being allowed to read data does not mean a model may receive it
([ADR-0067](../adr/0067-release-to-models-is-decided-for-the-model.md)).
TypeSys treats each model (or execution environment) as a principal of its
own, an **audience**, and decides every value for the person *and* the
audience it goes to.

## 1. Describe each model as an audience

```ts
import type { Audience } from "@typesys/core";

export const enclaveModel: Audience = {
  id: "model:squadron-enclave/triage",       // audited with every decision
  kind: "model",
  roles: ["ai-enclave"],                      // what your policies grant it
  attributes: { environment: "enclave", provider: "self-hosted" },
  clearance: "CUI"                            // decided by your classification scheme
};
```

An audience is granted nothing by default. Grant it in your policies as
you grant a role to a person, for example
`"airforce.read-aircraft": requireRole("maintainer", "viewer", "ai-enclave")`.
Give audiences roles no person holds.

## 2. Bind the audience where data leaves for a model

For an agent talking through MCP or HTTP, wrap the server's identity
resolver; everything the agent reads is then decided for its user and its
model:

```ts
import { bindAudience } from "@typesys/core";
createServer(backend, bindAudience(resolveIdentity, enclaveModel));
```

For a workflow, give the model its audience; each AI step's input is then
computed from what that audience may receive:

```ts
const model: AiModel = { id: "triage", audience: enclaveModel, complete: async (req) => callYourModel(req) };
```

A step that would send anything the model may not receive is refused and
audited. Declare `release: "redact"` on the AI step to send the model only
what it may receive instead. An AI step may not depend on an Action's
output (registration refuses it): read what the model needs in a read step.

## 3. Check it

Simulate with the same audience (`simulate(host, workflow, { audience, ... })`),
and read `workflow.release` rows in the audit log: each names the
audience and the needs whose values were withheld.
