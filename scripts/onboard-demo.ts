/**
 * Onboarding, end to end (ADR-0076), against a real PostgreSQL database and
 * the crew roster's real OpenAPI service:
 *
 *   npm run build && DATABASE_URL=postgres://... npm run onboard:demo
 *
 * It loads examples/onboarding/mxdb.sql (it drops and recreates schema `mx`
 * in that database), starts the roster, collects evidence from both,
 * proposes a baseline, refines it with the recorded agent-mode answer (or
 * a configured development model: TYPESYS_LLM_CONFIG, with
 * TYPESYS_ONBOARD_MODEL naming it), applies the expert's review, verifies
 * and installs what was approved, reads it through the runtime, and runs
 * the generated checks. Then the source changes and onboarding runs again
 * with no model: everything approved stays as approved, and only the change
 * is asked about. Outputs go to TYPESYS_ONBOARD_OUT (default: a temporary
 * directory).
 *
 * `-- --record` records examples/onboarding/refinement-answer.json as the
 * agent's answer to the current request, and `-- --write-review` writes the
 * demonstration's review; both are for maintaining the example.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { createLlm, loadLlmConfig, type LanguageModel, type LlmRecording } from "@typesys/llm";
import { adaptersFor, baseline, checkRuntime, decide, fromOpenApi, fromPostgres, introspectPostgres, onboard, recordedModel, recordRefinement, runChecks, sourceModel, type CollectedSource, type Proposal, type Refinement, type Review } from "@typesys/onboard";
import { createCrewRoster } from "../examples/services/crew-roster/server.mjs";

const HERE = path.resolve(import.meta.dirname, "../examples/onboarding");
const RECORDING = path.join(HERE, "recordings/refine.json");
const REVIEW = path.join(HERE, "review.json");
const read = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8")) as T;
const write = (file: string, value: unknown) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const say = (s = "") => console.log(s);

const url = process.env.DATABASE_URL;
if (!url) throw new Error("Set DATABASE_URL to a PostgreSQL database the demonstration may create schema mx in");
const pool = new pg.Pool({ connectionString: url });
const { server } = createCrewRoster();
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const rosterUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const out = process.env.TYPESYS_ONBOARD_OUT ?? mkdtempSync(path.join(os.tmpdir(), "typesys-onboard-"));
mkdirSync(out, { recursive: true });

try {
  await pool.query(readFileSync(path.join(HERE, "mxdb.sql"), "utf8"));
  const collect = async (): Promise<CollectedSource[]> => [
    fromPostgres(await introspectPostgres(pool, ["mx"]), { source: "mxdb", system: "MXDB" }),
    fromOpenApi(await (await fetch(`${rosterUrl}/openapi.json`)).json(), { source: "roster" })
  ];

  say("1. Evidence");
  const sources = await collect();
  const model = sourceModel(sources);
  say(`   ${model.evidence.size} facts from ${sources.map((s) => `${s.info.system} (${s.info.kind}, ${s.entities.length} entities)`).join(" and ")}; metadata only, no rows.`);

  if (process.argv.includes("--record")) {
    const base = baseline(model, "mx");
    const { recording, proposal } = await recordRefinement(model, base, read<Refinement>(path.join(HERE, "refinement-answer.json")), "A Claude Code session acting as the development model (agent mode): it read this request and wrote the answer");
    mkdirSync(path.dirname(RECORDING), { recursive: true });
    write(RECORDING, [recording]);
    say(`   Recorded ${recording.key.slice(0, 12)}…; ${proposal.rejected.length} of its items would be rejected.`);
  }

  say("2. Proposal");
  const configured = await loadLlmConfig(process.env.TYPESYS_LLM_CONFIG);
  const lm: LanguageModel = configured
    ? createLlm(configured).model(process.env.TYPESYS_ONBOARD_MODEL ?? configured.defaults?.development ?? "", "development")
    : recordedModel(read<LlmRecording[]>(RECORDING));
  say(`   Development model: ${configured ? `${process.env.TYPESYS_ONBOARD_MODEL ?? configured.defaults?.development} (configured)` : "the recorded agent-mode answer"}`);

  if (process.argv.includes("--write-review")) {
    const proposed = (await onboard({ domain: "mx", sources, model: lm })).proposal;
    write(REVIEW, expertReview(proposed));
    say("   Wrote the demonstration's review.");
  }
  const review = read<Review>(REVIEW);
  const first = await onboard({ domain: "mx", sources, model: lm, review });
  const m = first.metrics;
  say(`   Proposed ${m.proposed.types} Types, ${m.proposed.properties} properties, ${m.proposed.relationships.declared} declared and ${m.proposed.relationships.inferred} inferred relationships, ${m.proposed.sensitive} sensitive fields, ${m.proposed.actions} Actions, ${m.proposed.findings} findings.`);
  say(`   The model's answer: ${m.model?.inputTokens} input and ${m.model?.outputTokens} output tokens (${m.model?.estimated ? "estimated" : "reported"}); ${m.rejected} items refused by verification.`);
  for (const r of first.proposal.rejected) say(`     refused ${r.kind}: ${r.reason}`);
  for (const f of first.proposal.findings) say(`     finding (${f.severity}, ${f.author}): ${f.message}`);

  say("3. Review and verification");
  say(`   Approved ${m.approved.types} Types, ${m.approved.relationships} relationships, ${m.approved.sensitive} sensitive fields, ${m.approved.actions} Actions; ${m.pending} items pending.`);
  const v = first.verification;
  if (!v.ok || !v.pack) throw new Error(`Verification failed: ${JSON.stringify(v.diagnostics, null, 2)}`);
  say(`   Pack ${v.pack.name}@${v.pack.version} built and installed into a fresh registry; policy rules to write: ${v.built.policies.join(", ")}.`);
  write(path.join(out, "proposal.json"), first.proposal);
  write(path.join(out, "approved.json"), first.review.approved);
  write(path.join(out, "pack.json"), v.pack);
  write(path.join(out, "adapters.json"), v.built.adapters);

  say("4. Through the runtime");
  const secrets: Record<string, string> = { MXDB_URL: url, ROSTER_BASE_URL: rosterUrl, ROSTER_CLIENT_ID: "typesys-scheduler", ROSTER_CLIENT_SECRET: "scheduler-secret" };
  const env = await checkRuntime(v.pack, adaptersFor(v.built.adapters, { secret: (n) => secrets[n], pool: () => pool }));
  const results = await runChecks(env, v.checks);
  for (const r of results) say(`   ${r.outcome.padEnd(12)} ${r.id}: ${r.detail}`);
  const one = await env.runtime.getObject("mx.Aircraft", "AF86-0147", env.everything);
  say(`   mx.Aircraft AF86-0147, read as one object from MXDB: ${JSON.stringify(one.values)}`);
  write(path.join(out, "checks.json"), results);
  if (results.some((r) => r.outcome === "failed")) throw new Error("A generated check failed");

  say("5. The source changes; onboarding runs again with no model");
  await pool.query(`ALTER TABLE mx.acft ADD COLUMN eng_cyc integer; COMMENT ON COLUMN mx.acft.eng_cyc IS 'Engine cycles since last overhaul'`);
  const second = await onboard({ domain: "mx", sources: await collect(), review, approved: first.review.approved, previous: v.pack, version: "1.1.0" });
  const same = (a: Proposal) => JSON.stringify({ t: a.types.map((t) => [t.name, t.properties.map((x) => x.name)]), r: a.relationships.map((r) => [r.name, r.inverse]), a: a.actions.map((x) => x.name) });
  const kept = same(second.review.approved) === same(first.review.approved);
  say(`   Approved model ${kept ? "unchanged: every approved name, relationship and Action kept" : "CHANGED"}; pending: ${second.review.pending.map((p) => `${p.id} (${p.reason})`).join(", ") || "nothing"}.`);
  say(`   Upgrade check against 1.0.0: ${second.verification.ok ? "compatible" : JSON.stringify(second.verification.diagnostics)}.`);
  if (!kept) throw new Error("A rerun changed what was approved");
  say();
  say(`Outputs in ${out}`);
} finally {
  server.close();
  await pool.end();
}

/**
 * The demonstration's expert: accepts what was proposed, keeps one
 * inferred relationship out (the roster's tail number is free text the
 * expert does not trust as a reference), and renames one Action.
 */
function expertReview(p: Proposal): Review {
  const roster = p.relationships.find((r) => r.from.startsWith("schema:") || r.from.startsWith("openapi:"));
  return decide(p, undefined, {
    by: "maintenance data steward (demonstration)",
    at: "2026-10-16T00:00:00.000Z",
    acceptRest: true,
    ...(roster ? { reject: { [roster.id]: "The roster's tail number is typed by hand; not a reference until the roster validates it" } } : {})
  });
}
