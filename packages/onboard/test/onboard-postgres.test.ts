import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LlmRecording } from "@typesys/llm";
import { createCrewRoster } from "../../../examples/services/crew-roster/server.mjs";
import { adaptersFor, checkRuntime, fromOpenApi, fromPostgres, introspectPostgres, onboard, recordedModel, runChecks, type PgCatalog, type Review } from "../src/index.js";

/**
 * Onboarding against a live PostgreSQL database and the roster's live
 * OpenAPI service (ADR-0076): introspection reads what the committed
 * snapshot holds, and the approved model reads, follows, protects and
 * acts through the runtime. Needs DATABASE_URL; it creates and drops
 * schema `mx`.
 */
const url = process.env.DATABASE_URL;
const EXAMPLES = path.resolve(import.meta.dirname, "../../../examples");
const json = <T>(file: string): T => JSON.parse(readFileSync(path.join(EXAMPLES, file), "utf8")) as T;

describe.skipIf(!url)("onboarding a live PostgreSQL database and OpenAPI service", () => {
  let pool: pg.Pool;
  let server: Server;
  let rosterUrl: string;
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url });
    await pool.query(readFileSync(path.join(EXAMPLES, "onboarding/mxdb.sql"), "utf8"));
    server = createCrewRoster().server;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    rosterUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(async () => {
    server?.close();
    await pool?.query("DROP SCHEMA IF EXISTS mx CASCADE");
    await pool?.end();
  });

  it("reads the catalog the committed snapshot holds, from pg_catalog alone", async () => {
    const live = await introspectPostgres(pool, ["mx"]);
    const snapshot = json<PgCatalog>("onboarding/mxdb.catalog.json");
    expect({ ...live, database: snapshot.database }).toEqual(snapshot);
  });

  it("the approved model reads, follows relationships, withholds and marks, and invokes its Action through the runtime", async () => {
    const sources = [fromPostgres(await introspectPostgres(pool, ["mx"]), { source: "mxdb", system: "MXDB" }), fromOpenApi(await (await fetch(`${rosterUrl}/openapi.json`)).json(), { source: "roster" })];
    const r = await onboard({ domain: "mx", sources, model: recordedModel(json<LlmRecording[]>("onboarding/recordings/refine.json")), review: json<Review>("onboarding/review.json") });
    expect(r.verification.ok).toBe(true);
    const secrets: Record<string, string> = { MXDB_URL: url!, ROSTER_BASE_URL: rosterUrl, ROSTER_CLIENT_ID: "typesys-scheduler", ROSTER_CLIENT_SECRET: "scheduler-secret" };
    const env = await checkRuntime(r.verification.pack!, adaptersFor(r.verification.built.adapters, { secret: (n) => secrets[n], pool: () => pool }));
    const results = await runChecks(env, r.verification.checks);
    expect(results.filter((x) => x.outcome === "failed")).toEqual([]);
    expect(results.filter((x) => x.outcome === "passed").length).toBeGreaterThanOrEqual(r.verification.checks.length - 1);

    const aircraft = await env.runtime.getObject("mx.Aircraft", "AF86-0147", env.everything);
    expect(aircraft.values).toMatchObject({ tailNumber: "AF86-0147", missionCapability: "PMC", lastInspectionDate: "2026-09-30" });
    const below = await env.runtime.getObject("mx.Aircraft", "AF86-0147", env.clearedTo("CUI"));
    expect(below.values.deploymentLocation).toBeUndefined();

    const crew = r.review.approved.types.find((t) => t.name === "mx.CrewMember")!;
    const changed = (await env.runtime.invokeAction("ChangeDutyStatus", { [crew.key]: "C-1001", duty: "leave" }, env.everything)) as Record<string, unknown>;
    expect(changed).toMatchObject({ id: "C-1001", dutyStatus: "leave" });
    // The answer is the member as a read gives it to this caller, never the service's own record (M3 review M1).
    for (const who of [env.everything, env.without("mx.personal-name")]) {
      const answer = (await env.runtime.invokeAction("ChangeDutyStatus", { [crew.key]: "C-1001", duty: "available" }, who)) as Record<string, unknown>;
      const read = await env.runtime.getObject("mx.CrewMember", "C-1001", who);
      expect(Object.keys(answer).sort()).toEqual([...new Set(["id", ...Object.keys(read.values)])].sort());
      expect(JSON.stringify(answer)).not.toMatch(/full_name|home_unit/);
    }
    await expect(env.runtime.invokeAction("ChangeDutyStatus", { [crew.key]: "C-1001", duty: "leave" }, env.without("mx.invoke-change-duty-status"))).rejects.toThrow();
  });
});
