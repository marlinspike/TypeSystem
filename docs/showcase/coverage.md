# Showcase coverage

Generated from `packages/showcase/src/catalog.ts` by `npm run showcase -- coverage`. A test fails when this file and the catalog disagree.

## Capabilities and where each is shown

| Capability | Shown by | Question |
| --- | --- | --- |
| Sources over HTTP: API key, OAuth client credentials, Basic, cursor and numbered paging, envelopes | Cold Chain Command; Recall Response; Studio · Cold Chain | What systems are connected? |
| Sources in memory, mock REST and PostgreSQL | Runtime demo (PostgreSQL with DATABASE_URL) | What systems are connected? |
| Types, relationships and Actions described as the caller is told | Studio model tab; typesys app context; MCP typesys_discover | What business objects and capabilities do they represent? |
| Cross-source relationships resolved in place, and probed | Cold Chain shipment page; typesys app links | How are objects related across systems? |
| Object, row and field policy; classification by clearance | Guide identity comparison; Recall Response as each person; Runtime demo security tab | What can each identity see and do? |
| Explanations of any decision, for an inspector | Studio explain tab; typesys app why | What can each identity see and do? |
| Per-value provenance and computed values | Detail panels with provenance; Runtime demo explorer | Where does the information originate? |
| Typed SDK, REST API and the compiled application (4.0) | Recall Response; Cold Chain Command; Studio query tab | How can applications and Claude Code use these capabilities? |
| Claude Code through the CLI and MCP (development time) | .mcp.json; the recall challenge's transcripts | How can applications and Claude Code use these capabilities? |
| Runtime models: providers, audiences, release (@typesys/llm) | Cold Chain assessment; npm run showcase -- models; examples/apps/cold-chain/llm/ | How can applications and Claude Code use these capabilities? |
| Governed workflows: approvals, no self-approval, compensation | Recall Response; Cold Chain disposition; Guide workflow walk | How does a governed workflow operate? |
| Actions that require an approved workflow step (ADR-0096) | Guide workflow walk; typesys app why --invoke | How does a governed workflow operate? |
| Previews before an Action, and append-only audit | Studio actions tab; Runtime demo | How does a governed workflow operate? |
| Partial answers when a source fails; timeouts, retries, circuit breaker | Guide outage toggle; Runtime demo guardrails tab | What happens when a source system fails? |
| Change impact, predicted and observed | typesys app impact; Studio impact tab | What changes when a semantic definition or policy evolves? |
| Checker, acceptance checks, hidden checks, mutation testing | typesys app verify; packages/evaluation; npm run mutation | How does TypeSystem identify regressions and security consequences? |
| Onboarding a new source from its metadata | The challenge, stage A; npm run onboard:demo | What systems are connected? |
| Drafting a mission from words | npm run draft:demo | How can applications and Claude Code use these capabilities? |

## The ten questions

### What systems are connected?

Four independent services with four authentication schemes and no shared vocabulary, behind one runtime. Studio's graph as quality assurance (who may inspect) shows each source, the Types it serves and the policies over them; the guide shows whether each service is up right now.

- Sources in the governed graph, as QA: Studio · Cold Chain, `http://127.0.0.1:4401/#tab=graph&as=QA`
- The Air Force sources, as the maintenance lead: Studio · Air Force, `http://127.0.0.1:4400/#tab=graph&as=Lead`
- Terminal: `npx typesys app inspect examples/apps/recall-response --as qa`
- Terminal: `npx typesys app graph examples/apps/recall-response --as qa --view overview`
- MCP, runtime MCP (`typesys-runtime` in .mcp.json, or `npm run mcp:http`; the Air Force domain): `typesys_inspect`, `typesys_graph`
- Implemented in: `packages/cold-chain/src/adapters.ts`, `packages/cold-chain/src/recalls.ts`, `examples/services`

### What business objects and capabilities do they represent?

Types with fields, relationships and Actions, described as the caller is told of them. A Recall is the exchange's notice; a Lot is the inventory's; HoldLotsForRecall and FileRecallResponse are Actions that require an approved workflow step (ADR-0096). The task context is what Claude Code reads before writing an application.

- The Recall Type, as the coordinator: Studio · Cold Chain, `http://127.0.0.1:4401/#tab=model&as=Logistics&type=coldchain.Recall`
- An aircraft, its relationships and Actions: Runtime demo, `http://127.0.0.1:4000/#tab=explorer&as=maintainer&type=airforce.Aircraft&id=AF86-0147`
- Terminal: `npx typesys app context examples/apps/recall-response --as logistics --max-tokens 3000`
- Terminal: `npx typesys app catalog`
- MCP, application MCP (`typesys-app` in .mcp.json): `typesys_app_context`, `typesys_app_catalog`
- MCP, runtime MCP (`typesys-runtime` in .mcp.json, or `npm run mcp:http`; the Air Force domain): `typesys_discover`, `typesys_describe_type`, `typesys_list_actions`
- Implemented in: `packages/cold-chain/src/model.ts`, `packages/cold-chain/src/recalls.ts`, `packages/devkit/src/context.ts`

### How are objects related across systems?

A shipment in the tracker has lots in the inventory and readings in the sensor hub; relationships cross sources and are resolved in place. The Cold Chain shipment page joins all three; the links probe says which relationships resolve, and which dangle, as a caller.

- One shipment across three systems, as QA: Cold Chain Command, `http://127.0.0.1:4700/shipments/SH-1042?as=qa`
- The Shipment's neighbourhood in the graph: Studio · Cold Chain, `http://127.0.0.1:4401/#tab=graph&as=QA&node=type:coldchain.Shipment`
- Terminal: `npx typesys app links examples/apps/cold-chain --as qa --cross-source`
- MCP, runtime MCP (`typesys-runtime` in .mcp.json, or `npm run mcp:http`; the Air Force domain): `typesys_get_relationship`, `typesys_graph`
- Implemented in: `packages/cold-chain/src/model.ts`, `docs/adr/0094-links-across-systems-are-resolved-in-place-and-probed.md`

### What can each identity see and do?

The same read as six people. Quality assurance reads the embargoed notice and its health hazard; the coordinator and auditor are refused it and read public notices without the hazard; a carrier is refused every notice; someone not signed in sees nothing. Lot unit cost is CONFIDENTIAL, released only to a subject cleared for it. Explain says which policy, marking or rule decided each value.

- Why the coordinator is refused the embargoed notice: Studio · Cold Chain, `http://127.0.0.1:4401/#tab=explain&as=QA&type=coldchain.Recall&id=RCL-26-0388&for=user-logistics-1`
- The notices, as the coordinator: Recall Response, `http://127.0.0.1:4710/?as=logistics`
- The notices, as quality assurance: Recall Response, `http://127.0.0.1:4710/?as=qa`
- Field and row security in the runtime demo: Runtime demo, `http://127.0.0.1:4000/#tab=security&as=viewer`
- Terminal: `npx typesys app why examples/apps/recall-response --as qa --for logistics --read coldchain.Recall/RCL-26-0388`
- Terminal: `npx typesys app why examples/apps/cold-chain --as qa --for logistics --read coldchain.Lot/L-7731`
- MCP, runtime MCP (`typesys-runtime` in .mcp.json, or `npm run mcp:http`; the Air Force domain): `typesys_explain`, `typesys_get_object`
- Implemented in: `packages/cold-chain/src/recalls.ts`, `packages/core/src/runtime/runtime.ts`, `docs/adr/0089-an-explanation-is-the-runtimes-own-decision-replayed.md`
- What it does not show: Identities are demonstration tokens (ADR-0050); a deployment resolves them with @typesys/auth-oidc. Classification here is a demonstration scheme, not an accredited marking system.

### Where does the information originate?

Every value carries the system, record, field and time it came from; a computed value lists its inputs. Detail panels with provenance on show it per field; the aircraft's needsAttention is derived from two sources.

- Where an excursion's peak came from: Cold Chain Command, `http://127.0.0.1:4700/excursions/EX-301?as=qa`
- A notice, field by field, with provenance: Recall Response, `http://127.0.0.1:4710/notices/RCL-26-0412?as=qa`
- needsAttention and its inputs: Runtime demo, `http://127.0.0.1:4000/#tab=explorer&as=maintainer&type=airforce.Aircraft&id=AF86-0147`
- Terminal: `npx typesys app inspect examples/apps/recall-response --as qa --type coldchain.Recall`
- MCP, runtime MCP (`typesys-runtime` in .mcp.json, or `npm run mcp:http`; the Air Force domain): `typesys_get_provenance`
- Implemented in: `packages/core/src/model/provenance.ts`, `packages/adapter-http/src/http-adapter.ts`

### How can applications and Claude Code use these capabilities?

Applications call the governed API through the typed SDK, or are compiled from app.json (4.0). Claude Code, the coding agent, uses the same model through the CLI and the MCP tools in .mcp.json, and is told only what its caller may see. That is development-time use. Separately, at run time, an application's ai step asks a configured model (@typesys/llm), and the runtime decides what that model's audience may receive. The two never share credentials or configuration.

- An application compiled from app.json: Recall Response, `http://127.0.0.1:4710/?as=qa`
- A query, its plan and the SDK code that builds it: Studio · Cold Chain, `http://127.0.0.1:4401/#tab=query&as=Logistics&type=coldchain.Recall`
- Terminal: `npx typesys app check examples/apps/recall-response`
- Terminal: `npx typesys app compile examples/apps/recall-response`
- Terminal: `npx typesys app verify examples/apps/recall-response`
- Terminal: `npm run showcase -- models`
- MCP, application MCP (`typesys-app` in .mcp.json): `typesys_app_context`, `typesys_app_check`, `typesys_app_compile`, `typesys_app_verify`
- MCP, runtime MCP (`typesys-runtime` in .mcp.json, or `npm run mcp:http`; the Air Force domain): `typesys_query`, `typesys_preview_action`, `typesys_invoke_action`, `typesys_compile_context`
- Implemented in: `examples/apps/recall-response/app.json`, `packages/compiler/src/mcp.ts`, `packages/mcp-server/src/tools.ts`, `packages/llm/src/config.ts`, `docs/showcase/models.md`

### How does a governed workflow operate?

The recall response: the coordinator asks; the run reads the notice, checks it is answerable, finds our lots and shipments across three systems and waits on quality assurance. The coordinator cannot sign off, nor can a pharmacist sign off their own request. Only after a sign-off are the lots quarantined and the response filed, and a failed filing releases the lots. Calling the Actions directly is refused (ADR-0096).

- Ask to respond, as the coordinator: Recall Response, `http://127.0.0.1:4710/notices/RCL-26-0412?as=logistics`
- Sign it off, as quality assurance: Recall Response, `http://127.0.0.1:4710/?as=qa`
- A disposition with a model's assessment: Cold Chain Command, `http://127.0.0.1:4700/excursions/EX-301?as=logistics`
- Terminal: `npx typesys app why examples/apps/recall-response --as logistics --invoke HoldLotsForRecall --input '{"recallId":"RCL-26-0412","lotIds":["L-7701"]}'`
- MCP, runtime MCP (`typesys-runtime` in .mcp.json, or `npm run mcp:http`; the Air Force domain): `typesys_preview_action`
- Implemented in: `examples/apps/recall-response/app.json`, `packages/workflow/src/engine.ts`, `docs/adr/0096-an-action-can-require-an-approved-workflow-step.md`, `docs/adr/0097-a-workflow-run-can-be-about-an-object.md`

### What happens when a source system fails?

Stop the pharmacy inventory from the guide. A shipment still reads from the tracker and the sensor hub; its lots, and the sites the inventory holds, answer 503 and the page says the service could not answer, never shows an empty list. A recall run fails at the read it could not make, before anything is held. Start it again and the same pages recover.

- A shipment with one system down: Cold Chain Command, `http://127.0.0.1:4700/shipments/SH-1042?as=qa`
- Timeouts, retries and the circuit breaker: Runtime demo, `http://127.0.0.1:4000/#tab=guardrails&as=maintainer`
- Terminal: `npx typesys app links examples/apps/cold-chain --as qa --cross-source`
- MCP, runtime MCP (`typesys-runtime` in .mcp.json, or `npm run mcp:http`; the Air Force domain): `typesys_get_relationship`
- Implemented in: `packages/core/src/runtime/runtime.ts`, `docs/adr/0072-independent-services-behind-one-governed-contract.md`

### What changes when a semantic definition or policy evolves?

Record a baseline, change the model, compare. In the challenge, removing the embargo condition from the recall read policy was reported as a governance change and 28 new exposures: every field of the embargoed notice now returned to the coordinator and the auditor. The command exits 1, and names the checks to run.

- Impact in Studio: Studio · Cold Chain, `http://127.0.0.1:4401/#tab=impact&as=QA`
- Impact of the Air Force proposal: Studio · Air Force, `http://127.0.0.1:4400/#tab=impact&as=Lead`
- Terminal: `npx typesys app impact examples/apps/recall-response --as qa --record baseline.json`
- Terminal: `npx typesys app impact examples/apps/recall-response --as qa --against baseline.json`
- Terminal: `npx typesys app diff examples/apps/recall-response --against <previous app.json>`
- MCP, runtime MCP (`typesys-runtime` in .mcp.json, or `npm run mcp:http`; the Air Force domain): `typesys_impact`
- MCP, application MCP (`typesys-app` in .mcp.json): `typesys_app_diff`
- Implemented in: `packages/devkit/src/impact.ts`, `docs/evidence/showcase-challenge/transcript/07-evolve.txt`, `docs/adr/0099-impact-probes-the-objects-an-applications-checks-name.md`

### How does TypeSystem identify regressions and security consequences?

At every layer. The checker refuses a flow that invokes an approval-required Action without an approval, or an AI step's output reaching an Action unreviewed. Acceptance checks run as each caller through the API and in a browser. Impact compares decisions before and after. Hidden checks written before any code scored all three challenge runs. Mutation testing proves the tests catch planted defects.

- Exposures in Studio's impact view: Studio · Cold Chain, `http://127.0.0.1:4401/#tab=impact&as=QA`
- Terminal: `npx typesys app verify examples/apps/recall-response`
- Terminal: `node packages/evaluation/dist/bin.js score --task recall-response --arm agent-with --dir examples/apps/recall-response --source agent --producer you`
- Terminal: `npm run mutation`
- MCP, application MCP (`typesys-app` in .mcp.json): `typesys_app_check`, `typesys_app_verify`
- Implemented in: `packages/workflow/src/validate.ts`, `packages/compiler/src/check.ts`, `packages/evaluation/hidden/recall-response.mjs`, `docs/evidence/showcase-challenge/README.md`
- What it does not show: The mutation suite runs for more than half an hour, so it is started by hand (locally, or as a manual workflow), never on a pull request. The hidden checks did not separate the three challenge runs: all scored 16 of 16.

## Lifecycle stages of the challenge

| Stage | What happens | Evidence |
| --- | --- | --- |
| A. Discover and connect | Onboard the recall exchange from its OpenAPI document: a proposal citing evidence, kept apart from the approved definition, then checked against the live service. | `docs/evidence/showcase-challenge/transcript/01-discover.txt` |
| B. Understand | Read the model as the coordinator: the task context, what each caller may do and why. | `docs/evidence/showcase-challenge/transcript/03-understand.txt` |
| C. Build | Write app.json, check, compile, build: the flow, two pages and 22 acceptance checks. | `docs/evidence/showcase-challenge/transcript/04-build.txt` |
| D. Operate | Verify as every caller, in the API and a browser; then score against the 16 hidden checks. | `docs/evidence/showcase-challenge/transcript/05-verify.txt` |
| E. Evolve | Remove the embargo condition, measure the impact, fix it. | `docs/evidence/showcase-challenge/transcript/07-evolve.txt` |
| F. Verify | Hidden checks, the comparison with and without TypeSystem's tools, and what it does not show. | `docs/evidence/showcase-challenge/README.md` |
