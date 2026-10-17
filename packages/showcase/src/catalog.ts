/**
 * The showcase's content as data: ten engineering questions, each answered
 * on a running surface, with the command and MCP tool that answer it
 * without a browser and the source that implements it. The guide renders
 * it, `docs/showcase/coverage.md` is generated from it, and its tests check
 * that every path it names exists.
 */

/** The running surfaces, by key: each is a process the launcher starts. */
export const SURFACES = {
  guide: { title: "Showcase guide", port: 4300, what: "This guide: the ten questions, live identity comparison, outages and the workflow walk." },
  demo: { title: "Runtime demo", port: 4000, what: "The Air Force and hospital domains over in-memory, mock REST and (optionally) PostgreSQL sources, as each identity, with both policy engines." },
  studioAirforce: { title: "Studio · Air Force", port: 4400, what: "The semantic workbench over the Air Force domain: model, graph, explanations, impact, queries and Actions." },
  studioColdChain: { title: "Studio · Cold Chain", port: 4401, what: "The workbench over the cold chain and the recall exchange, four systems, with both applications in its graph." },
  coldChain: { title: "Cold Chain Command", port: 4700, what: "The compiled 4.0 reference application over a shipment tracker, a sensor hub and a pharmacy inventory." },
  recall: { title: "Recall Response", port: 4710, what: "The application Claude Code built in the showcase's challenge, over those three and an industry recall exchange." }
} as const;
export type SurfaceKey = keyof typeof SURFACES;

/** The independent services, on fixed ports so an outage and a reset find them where they were. Plain Node, no TypeSystem code. */
export const SERVICES = {
  "shipment-tracker": { port: 4801, env: "TYPESYS_COLDCHAIN_TRACKER_URL", system: "Shipment tracker", auth: "API key" },
  "sensor-hub": { port: 4802, env: "TYPESYS_COLDCHAIN_SENSORS_URL", system: "Sensor hub", auth: "OAuth 2.0 client credentials" },
  "pharmacy-inventory": { port: 4803, env: "TYPESYS_COLDCHAIN_INVENTORY_URL", system: "Pharmacy inventory", auth: "API key, read-only or operations" },
  "recall-exchange": { port: 4804, env: "TYPESYS_COLDCHAIN_RECALLS_URL", system: "Recall exchange", auth: "HTTP Basic" }
} as const;
export type ServiceKey = keyof typeof SERVICES;

/** The OpenAI-compatible stand-in the showcase serves on loopback, so a real provider path runs offline. Labelled simulated everywhere. */
export const SIMULATED_LLM = { port: 4790, config: "examples/apps/cold-chain/llm/simulated.json" } as const;

export interface SurfaceLink {
  readonly surface: SurfaceKey;
  /** Path, query and hash on that surface. */
  readonly path: string;
  readonly label: string;
}

export interface Question {
  readonly id: string;
  readonly question: string;
  /** What the surfaces show, and what to look for. */
  readonly answer: string;
  readonly links: readonly SurfaceLink[];
  /** A panel of the guide that answers it live. */
  readonly live?: "systems" | "compare" | "outage" | "workflow" | "models";
  /** The same answer from a terminal, run from the repository root. */
  readonly cli: readonly string[];
  /** The same answer over MCP: the server and its tools. */
  readonly mcp: readonly { readonly server: string; readonly tools: readonly string[] }[];
  /** Where it is implemented and decided. */
  readonly sources: readonly string[];
  /** What it does not show, said plainly. */
  readonly limits?: string;
}

const CC = "examples/apps/cold-chain";
const RR = "examples/apps/recall-response";
const RUNTIME_MCP = "runtime MCP (`typesys-runtime` in .mcp.json, or `npm run mcp:http`; the Air Force domain)";
const APP_MCP = "application MCP (`typesys-app` in .mcp.json)";

export const QUESTIONS: readonly Question[] = [
  {
    id: "systems",
    question: "What systems are connected?",
    answer:
      "Four independent services with four authentication schemes and no shared vocabulary, behind one runtime. Studio's graph as quality assurance (who may inspect) shows each source, the Types it serves and the policies over them; the guide shows whether each service is up right now.",
    links: [
      { surface: "studioColdChain", path: "/#tab=graph&as=QA", label: "Sources in the governed graph, as QA" },
      { surface: "studioAirforce", path: "/#tab=graph&as=Lead", label: "The Air Force sources, as the maintenance lead" }
    ],
    live: "systems",
    cli: [`npx typesys app inspect ${RR} --as qa`, `npx typesys app graph ${RR} --as qa --view overview`],
    mcp: [{ server: RUNTIME_MCP, tools: ["typesys_inspect", "typesys_graph"] }],
    sources: ["packages/cold-chain/src/adapters.ts", "packages/cold-chain/src/recalls.ts", "examples/services"]
  },
  {
    id: "objects",
    question: "What business objects and capabilities do they represent?",
    answer:
      "Types with fields, relationships and Actions, described as the caller is told of them. A Recall is the exchange's notice; a Lot is the inventory's; HoldLotsForRecall and FileRecallResponse are Actions that require an approved workflow step (ADR-0096). The task context is what Claude Code reads before writing an application.",
    links: [
      { surface: "studioColdChain", path: "/#tab=model&as=Logistics&type=coldchain.Recall", label: "The Recall Type, as the coordinator" },
      { surface: "demo", path: "/#tab=explorer&as=maintainer&type=airforce.Aircraft&id=AF86-0147", label: "An aircraft, its relationships and Actions" }
    ],
    cli: [`npx typesys app context ${RR} --as logistics --max-tokens 3000`, "npx typesys app catalog"],
    mcp: [
      { server: APP_MCP, tools: ["typesys_app_context", "typesys_app_catalog"] },
      { server: RUNTIME_MCP, tools: ["typesys_discover", "typesys_describe_type", "typesys_list_actions"] }
    ],
    sources: ["packages/cold-chain/src/model.ts", "packages/cold-chain/src/recalls.ts", "packages/devkit/src/context.ts"]
  },
  {
    id: "relationships",
    question: "How are objects related across systems?",
    answer:
      "A shipment in the tracker has lots in the inventory and readings in the sensor hub; relationships cross sources and are resolved in place. The Cold Chain shipment page joins all three; the links probe says which relationships resolve, and which dangle, as a caller.",
    links: [
      { surface: "coldChain", path: "/shipments/SH-1042?as=qa", label: "One shipment across three systems, as QA" },
      { surface: "studioColdChain", path: "/#tab=graph&as=QA&node=type:coldchain.Shipment", label: "The Shipment's neighbourhood in the graph" }
    ],
    cli: [`npx typesys app links ${CC} --as qa --cross-source`],
    mcp: [{ server: RUNTIME_MCP, tools: ["typesys_get_relationship", "typesys_graph"] }],
    sources: ["packages/cold-chain/src/model.ts", "docs/adr/0094-links-across-systems-are-resolved-in-place-and-probed.md"]
  },
  {
    id: "identity",
    question: "What can each identity see and do?",
    answer:
      "The same read as six people. Quality assurance reads the embargoed notice and its health hazard; the coordinator and auditor are refused it and read public notices without the hazard; a carrier is refused every notice; someone not signed in sees nothing. Lot unit cost is CONFIDENTIAL, released only to a subject cleared for it. Explain says which policy, marking or rule decided each value.",
    links: [
      { surface: "studioColdChain", path: "/#tab=explain&as=QA&type=coldchain.Recall&id=RCL-26-0388&for=user-logistics-1", label: "Why the coordinator is refused the embargoed notice" },
      { surface: "recall", path: "/?as=logistics", label: "The notices, as the coordinator" },
      { surface: "recall", path: "/?as=qa", label: "The notices, as quality assurance" },
      { surface: "demo", path: "/#tab=security&as=viewer", label: "Field and row security in the runtime demo" }
    ],
    live: "compare",
    cli: [`npx typesys app why ${RR} --as qa --for logistics --read coldchain.Recall/RCL-26-0388`, `npx typesys app why ${CC} --as qa --for logistics --read coldchain.Lot/L-7731`],
    mcp: [{ server: RUNTIME_MCP, tools: ["typesys_explain", "typesys_get_object"] }],
    sources: ["packages/cold-chain/src/recalls.ts", "packages/core/src/runtime/runtime.ts", "docs/adr/0089-an-explanation-is-the-runtimes-own-decision-replayed.md"],
    limits:
      "Identities are demonstration tokens (ADR-0050); a deployment resolves them with @typesys/auth-oidc. Classification here is a demonstration scheme, not an accredited marking system."
  },
  {
    id: "provenance",
    question: "Where does the information originate?",
    answer:
      "Every value carries the system, record, field and time it came from; a computed value lists its inputs. Detail panels with provenance on show it per field; the aircraft's needsAttention is derived from two sources.",
    links: [
      { surface: "coldChain", path: "/excursions/EX-301?as=qa", label: "Where an excursion's peak came from" },
      { surface: "recall", path: "/notices/RCL-26-0412?as=qa", label: "A notice, field by field, with provenance" },
      { surface: "demo", path: "/#tab=explorer&as=maintainer&type=airforce.Aircraft&id=AF86-0147", label: "needsAttention and its inputs" }
    ],
    cli: [`npx typesys app inspect ${RR} --as qa --type coldchain.Recall`],
    mcp: [{ server: RUNTIME_MCP, tools: ["typesys_get_provenance"] }],
    sources: ["packages/core/src/model/provenance.ts", "packages/adapter-http/src/http-adapter.ts"]
  },
  {
    id: "consumers",
    question: "How can applications and Claude Code use these capabilities?",
    answer:
      "Applications call the governed API through the typed SDK, or are compiled from app.json (4.0). Claude Code, the coding agent, uses the same model through the CLI and the MCP tools in .mcp.json, and is told only what its caller may see. That is development-time use. Separately, at run time, an application's ai step asks a configured model (@typesys/llm), and the runtime decides what that model's audience may receive. The two never share credentials or configuration.",
    links: [
      { surface: "recall", path: "/?as=qa", label: "An application compiled from app.json" },
      { surface: "studioColdChain", path: "/#tab=query&as=Logistics&type=coldchain.Recall", label: "A query, its plan and the SDK code that builds it" }
    ],
    live: "models",
    cli: [`npx typesys app check ${RR}`, `npx typesys app compile ${RR}`, `npx typesys app verify ${RR}`, "npm run showcase -- models"],
    mcp: [
      { server: APP_MCP, tools: ["typesys_app_context", "typesys_app_check", "typesys_app_compile", "typesys_app_verify"] },
      { server: RUNTIME_MCP, tools: ["typesys_query", "typesys_preview_action", "typesys_invoke_action", "typesys_compile_context"] }
    ],
    sources: [`${RR}/app.json`, "packages/compiler/src/mcp.ts", "packages/mcp-server/src/tools.ts", "packages/llm/src/config.ts", "docs/showcase/models.md"]
  },
  {
    id: "workflow",
    question: "How does a governed workflow operate?",
    answer:
      "The recall response: the coordinator asks; the run reads the notice, checks it is answerable, finds our lots and shipments across three systems and waits on quality assurance. The coordinator cannot sign off, nor can a pharmacist sign off their own request. Only after a sign-off are the lots quarantined and the response filed, and a failed filing releases the lots. Calling the Actions directly is refused (ADR-0096).",
    links: [
      { surface: "recall", path: "/notices/RCL-26-0412?as=logistics", label: "Ask to respond, as the coordinator" },
      { surface: "recall", path: "/?as=qa", label: "Sign it off, as quality assurance" },
      { surface: "coldChain", path: "/excursions/EX-301?as=logistics", label: "A disposition with a model's assessment" }
    ],
    live: "workflow",
    cli: [`npx typesys app why ${RR} --as logistics --invoke HoldLotsForRecall --input '{"recallId":"RCL-26-0412","lotIds":["L-7701"]}'`],
    mcp: [{ server: RUNTIME_MCP, tools: ["typesys_preview_action"] }],
    sources: [`${RR}/app.json`, "packages/workflow/src/engine.ts", "docs/adr/0096-an-action-can-require-an-approved-workflow-step.md", "docs/adr/0097-a-workflow-run-can-be-about-an-object.md"]
  },
  {
    id: "failure",
    question: "What happens when a source system fails?",
    answer:
      "Stop the pharmacy inventory from the guide. A shipment still reads from the tracker and the sensor hub; its lots, and the sites the inventory holds, answer 503 and the page says the service could not answer, never shows an empty list. A recall run fails at the read it could not make, before anything is held. Start it again and the same pages recover.",
    links: [
      { surface: "coldChain", path: "/shipments/SH-1042?as=qa", label: "A shipment with one system down" },
      { surface: "demo", path: "/#tab=guardrails&as=maintainer", label: "Timeouts, retries and the circuit breaker" }
    ],
    live: "outage",
    cli: [`npx typesys app links ${CC} --as qa --cross-source`],
    mcp: [{ server: RUNTIME_MCP, tools: ["typesys_get_relationship"] }],
    sources: ["packages/core/src/runtime/runtime.ts", "docs/adr/0072-independent-services-behind-one-governed-contract.md"]
  },
  {
    id: "evolve",
    question: "What changes when a semantic definition or policy evolves?",
    answer:
      "Record a baseline, change the model, compare. In the challenge, removing the embargo condition from the recall read policy was reported as a governance change and 28 new exposures: every field of the embargoed notice now returned to the coordinator and the auditor. The command exits 1, and names the checks to run.",
    links: [
      { surface: "studioColdChain", path: "/#tab=impact&as=QA", label: "Impact in Studio" },
      { surface: "studioAirforce", path: "/#tab=impact&as=Lead", label: "Impact of the Air Force proposal" }
    ],
    cli: [`npx typesys app impact ${RR} --as qa --record baseline.json`, `npx typesys app impact ${RR} --as qa --against baseline.json`, `npx typesys app diff ${RR} --against <previous app.json>`],
    mcp: [
      { server: RUNTIME_MCP, tools: ["typesys_impact"] },
      { server: APP_MCP, tools: ["typesys_app_diff"] }
    ],
    sources: ["packages/devkit/src/impact.ts", "docs/evidence/showcase-challenge/transcript/07-evolve.txt", "docs/adr/0099-impact-probes-the-objects-an-applications-checks-name.md"]
  },
  {
    id: "regressions",
    question: "How does TypeSystem identify regressions and security consequences?",
    answer:
      "At every layer. The checker refuses a flow that invokes an approval-required Action without an approval, or an AI step's output reaching an Action unreviewed. Acceptance checks run as each caller through the API and in a browser. Impact compares decisions before and after. Hidden checks written before any code scored all three challenge runs. Mutation testing proves the tests catch planted defects.",
    links: [{ surface: "studioColdChain", path: "/#tab=impact&as=QA", label: "Exposures in Studio's impact view" }],
    cli: [`npx typesys app verify ${RR}`, `node packages/evaluation/dist/bin.js score --task recall-response --arm agent-with --dir ${RR} --source agent --producer you`, "npm run mutation"],
    limits: "The mutation suite runs for more than half an hour, so it is started by hand (locally, or as a manual workflow), never on a pull request. The hidden checks did not separate the three challenge runs: all scored 16 of 16.",
    mcp: [{ server: APP_MCP, tools: ["typesys_app_check", "typesys_app_verify"] }],
    sources: ["packages/workflow/src/validate.ts", "packages/compiler/src/check.ts", "packages/evaluation/hidden/recall-response.mjs", "docs/evidence/showcase-challenge/README.md"]
  }
];

/** The lifecycle the challenge walks, stage by stage, with its evidence. */
export const STAGES: readonly { readonly id: string; readonly title: string; readonly what: string; readonly evidence: string }[] = [
  { id: "A", title: "Discover and connect", what: "Onboard the recall exchange from its OpenAPI document: a proposal citing evidence, kept apart from the approved definition, then checked against the live service.", evidence: "docs/evidence/showcase-challenge/transcript/01-discover.txt" },
  { id: "B", title: "Understand", what: "Read the model as the coordinator: the task context, what each caller may do and why.", evidence: "docs/evidence/showcase-challenge/transcript/03-understand.txt" },
  { id: "C", title: "Build", what: "Write app.json, check, compile, build: the flow, two pages and 22 acceptance checks.", evidence: "docs/evidence/showcase-challenge/transcript/04-build.txt" },
  { id: "D", title: "Operate", what: "Verify as every caller, in the API and a browser; then score against the 16 hidden checks.", evidence: "docs/evidence/showcase-challenge/transcript/05-verify.txt" },
  { id: "E", title: "Evolve", what: "Remove the embargo condition, measure the impact, fix it.", evidence: "docs/evidence/showcase-challenge/transcript/07-evolve.txt" },
  { id: "F", title: "Verify", what: "Hidden checks, the comparison with and without TypeSystem's tools, and what it does not show.", evidence: "docs/evidence/showcase-challenge/README.md" }
];

/** Which demonstration shows each capability. Generated into docs/showcase/coverage.md. */
export const COVERAGE: readonly { readonly feature: string; readonly shownBy: readonly string[]; readonly question?: string }[] = [
  { feature: "Sources over HTTP: API key, OAuth client credentials, Basic, cursor and numbered paging, envelopes", shownBy: ["Cold Chain Command", "Recall Response", "Studio · Cold Chain"], question: "systems" },
  { feature: "Sources in memory, mock REST and PostgreSQL", shownBy: ["Runtime demo (PostgreSQL with DATABASE_URL)"], question: "systems" },
  { feature: "Types, relationships and Actions described as the caller is told", shownBy: ["Studio model tab", "typesys app context", "MCP typesys_discover"], question: "objects" },
  { feature: "Cross-source relationships resolved in place, and probed", shownBy: ["Cold Chain shipment page", "typesys app links"], question: "relationships" },
  { feature: "Object, row and field policy; classification by clearance", shownBy: ["Guide identity comparison", "Recall Response as each person", "Runtime demo security tab"], question: "identity" },
  { feature: "Explanations of any decision, for an inspector", shownBy: ["Studio explain tab", "typesys app why"], question: "identity" },
  { feature: "Per-value provenance and computed values", shownBy: ["Detail panels with provenance", "Runtime demo explorer"], question: "provenance" },
  { feature: "Typed SDK, REST API and the compiled application (4.0)", shownBy: ["Recall Response", "Cold Chain Command", "Studio query tab"], question: "consumers" },
  { feature: "Claude Code through the CLI and MCP (development time)", shownBy: [".mcp.json", "the recall challenge's transcripts"], question: "consumers" },
  { feature: "Runtime models: providers, audiences, release (@typesys/llm)", shownBy: ["Cold Chain assessment", "npm run showcase -- models", "examples/apps/cold-chain/llm/"], question: "consumers" },
  { feature: "Governed workflows: approvals, no self-approval, compensation", shownBy: ["Recall Response", "Cold Chain disposition", "Guide workflow walk"], question: "workflow" },
  { feature: "Actions that require an approved workflow step (ADR-0096)", shownBy: ["Guide workflow walk", "typesys app why --invoke"], question: "workflow" },
  { feature: "Previews before an Action, and append-only audit", shownBy: ["Studio actions tab", "Runtime demo"], question: "workflow" },
  { feature: "Partial answers when a source fails; timeouts, retries, circuit breaker", shownBy: ["Guide outage toggle", "Runtime demo guardrails tab"], question: "failure" },
  { feature: "Change impact, predicted and observed", shownBy: ["typesys app impact", "Studio impact tab"], question: "evolve" },
  { feature: "Checker, acceptance checks, hidden checks, mutation testing", shownBy: ["typesys app verify", "packages/evaluation", "npm run mutation"], question: "regressions" },
  { feature: "Onboarding a new source from its metadata", shownBy: ["The challenge, stage A", "npm run onboard:demo"], question: "systems" },
  { feature: "Drafting a mission from words", shownBy: ["npm run draft:demo"], question: "consumers" }
];
