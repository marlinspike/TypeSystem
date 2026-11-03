import { describe, it, expect, afterAll } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { corePack } from "@typesys/packs";
import { airforcePack } from "@typesys/domain-airforce";
import { airforceDeployment, airforceExtension } from "@typesys/demo-web/deployments";
import { InvalidInputError } from "@typesys/core";
import { acceptanceFor, applyAcceptance, checkDeployment, renderDeployCheck, validateAcceptance, type DeploymentBuild } from "../src/check.js";
import { buildHost, emptyEnvironment } from "../src/host.js";
import { DeploymentError, validateDeployment, type Deployment } from "../src/deployment.js";
import { runTests, renderTests, validateTests, testsFileFor, loadTests, type DeploymentTests } from "../src/tests.js";
import { startDev, welcome } from "../src/dev.js";
import { serve } from "../src/serve.js";
import { deployCommand } from "../src/cli.js";

/** ADR-0112..0114: what a developer meets first. Policy tests, accepting a meant change, the dev server, and the first answers a server gives. */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const airforceFile = path.join(root, "deployments/airforce.deployment.json");
const current: DeploymentBuild = { deployment: airforceDeployment, packs: [corePack, airforcePack], extensions: [airforceExtension], env: emptyEnvironment };
const host = () => buildHost(airforceDeployment, { packs: [corePack, airforcePack], extensions: [airforceExtension], env: emptyEnvironment });

describe("policy tests as data (ADR-0113)", () => {
  it("the shipped airforce tests pass: the three callers of the README, a list, and an Action preview each way", async () => {
    const h = await host();
    try {
      const report = await runTests(h, await loadTests(testsFileFor(airforceFile), h));
      expect(report.outcomes.filter((o) => !o.ok)).toEqual([]);
      expect(report.passed).toBe(6);
      expect(renderTests(report)).toContain("PASS: 6 passed, 0 failed");
    } finally {
      await h.close();
    }
  });

  it("fails each kind of promise the rules no longer keep, saying what was seen", async () => {
    const h = await host();
    try {
      const doc: DeploymentTests = {
        format: "typesys.deployment-tests/1",
        tests: [
          { as: "viewer", read: "airforce.Aircraft/AF86-0147", returns: ["maintenanceStatus"] },
          { as: "maintainer", read: "airforce.Aircraft/AF86-0147", withholds: ["maintenanceStatus"] },
          { as: "maintainer", read: "airforce.Aircraft/AF86-0147", refused: true },
          { as: "anonymous", read: "airforce.Aircraft/AF86-0147" },
          { as: "maintainer", query: "airforce.Aircraft", withholds: ["tailNumber"] },
          { as: "maintainer", query: "airforce.Aircraft", refused: true },
          { as: "viewer", invoke: { action: "CreateMaintenanceWorkOrder", input: { maintenanceEventId: "EVT-9001", assignedTo: "x" } } },
          { as: "maintainer", invoke: { action: "CreateMaintenanceWorkOrder", input: { maintenanceEventId: "EVT-9001", assignedTo: "x" } }, refused: true }
        ]
      };
      const report = await runTests(h, doc);
      expect(report.ok).toBe(false);
      expect(report.passed).toBe(0);
      const details = report.outcomes.map((o) => o.detail);
      expect(details[0]).toBe("maintenanceStatus was not returned");
      expect(details[1]).toBe("maintenanceStatus was returned");
      expect(details[2]).toBe("allowed, and the test says it must be refused");
      expect(details[3]).toMatch(/^refused: /);
      expect(details[4]).toMatch(/^tailNumber was returned on \d+ of \d+ objects$/);
      expect(details[5]).toMatch(/^returned \d+ object\(s\), and the test says it must be refused$/);
      expect(details[6]).toMatch(/^refused: /);
      expect(details[7]).toBe("authorized, and the test says it must be refused");
      expect(report.outcomes[0]!.name).toBe("viewer reads airforce.Aircraft/AF86-0147, returns maintenanceStatus");
    } finally {
      await h.close();
    }
  });

  it("a returns test over an empty query fails rather than passing on nothing", async () => {
    const h = await host();
    try {
      const report = await runTests(h, {
        format: "typesys.deployment-tests/1",
        tests: [{ as: "maintainer", query: { type: "airforce.Aircraft", filter: { property: "tailNumber", operator: "eq", value: "NONE" } }, returns: ["tailNumber"] }]
      });
      expect(report.outcomes[0]).toMatchObject({ ok: false, detail: "the query returned no objects, so nothing it returns could be checked" });
    } finally {
      await h.close();
    }
  });

  it("refuses a tests document it cannot run, naming every problem", () => {
    expect(validateTests({ tests: [] }, ["viewer"])).toEqual(['must be a typesys.deployment-tests/1 document: { "format": "typesys.deployment-tests/1", "tests": [...] }']);
    expect(
      validateTests(
        {
          format: "typesys.deployment-tests/1",
          tests: [
            { as: "nobody", read: "x" },
            { as: "viewer", read: "T/1", query: "T" },
            { as: "viewer", invoke: { action: "A", input: {} }, returns: ["x"] },
            { as: "viewer", read: "T/1", refused: true, withholds: ["x"] },
            { as: "viewer", read: "T/1", extra: 1 }
          ]
        },
        ["viewer", "anonymous"]
      )
    ).toEqual([
      'tests[0].as: must name a persona the deployment declares (viewer, anonymous), not "nobody"',
      'tests[0].read: must be "<Type>/<id>"',
      "tests[1]: must have exactly one of read, query, invoke",
      "tests[2]: an invoke test says only whether the persona is refused",
      "tests[3]: a refused test returns nothing to compare",
      'tests[4]: unknown field "extra"'
    ]);
  });

  it("finds the tests beside a deployment by name", () => {
    expect(testsFileFor("/d/shop.deployment.json")).toBe("/d/shop.tests.json");
    expect(testsFileFor("/d/shop.json")).toBe("/d/shop.tests.json");
  });

  it("typesys deploy test exits 1 on a failure and 0 when every test passes", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "typesys-tests-"));
    try {
      const failing = path.join(dir, "failing.tests.json");
      writeFileSync(failing, JSON.stringify({ format: "typesys.deployment-tests/1", tests: [{ as: "viewer", read: "airforce.Aircraft/AF86-0147", returns: ["maintenanceStatus"] }] }));
      expect(await deployCommand(["test", airforceFile, failing])).toBe(1);
      expect(await deployCommand(["test", airforceFile])).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("accepting a meant upgrade change (ADR-0114)", () => {
  const widened: Deployment = { ...airforceDeployment, policies: { ...airforceDeployment.policies, "airforce.maintainer-only": { role: ["maintainer", "viewer", "ai-enclave"] } } };
  const next: DeploymentBuild = { ...current, deployment: widened };

  it("passes a check whose every blocking line is accepted for these two builds, and shows who accepted what", async () => {
    const report = await checkDeployment(current, next);
    expect(report.ok).toBe(false);
    const acceptance = acceptanceFor(report, "R. Owner", "viewers now need maintenance status for the readiness board");
    expect(validateAcceptance(acceptance)).toEqual([]);
    expect(acceptance.from).toBe(report.before.build);
    expect(acceptance.accepted.map((a) => a.blocking)).toEqual(report.blocking);
    const accepted = applyAcceptance(report, acceptance);
    expect(accepted.ok).toBe(true);
    expect(accepted.blocking).toEqual([]);
    expect(accepted.accepted).toHaveLength(report.blocking.length);
    expect(renderDeployCheck(accepted)).toContain(`OK: ${report.blocking.length} blocking changes accepted, nothing else blocks this upgrade.`);
    expect(renderDeployCheck(accepted)).toContain("✓ accepted by R. Owner (viewers now need maintenance status for the readiness board): ");
  });

  it("still blocks a line the acceptance does not name, and a line it accepts that no longer blocks", async () => {
    const report = await checkDeployment(current, next);
    const acceptance = acceptanceFor(report, "R. Owner", "meant");
    const partial = { ...acceptance, accepted: [...acceptance.accepted.slice(1), { blocking: "exposure: someone reads something", by: "R. Owner", why: "meant" }] };
    const applied = applyAcceptance(report, partial);
    expect(applied.ok).toBe(false);
    expect(applied.blocking).toEqual([report.blocking[0], 'acceptance: accepts "exposure: someone reads something", which this check does not block on; remove it or write the acceptance again']);
  });

  it("refuses an acceptance written for another pair of builds, whole", async () => {
    const report = await checkDeployment(current, next);
    const other = { ...acceptanceFor(report, "R. Owner", "meant"), to: `sha256:${"1".repeat(64)}` };
    const applied = applyAcceptance(report, other);
    expect(applied.ok).toBe(false);
    expect(applied.accepted).toEqual([]);
    expect(applied.blocking.slice(0, -1)).toEqual(report.blocking);
    expect(applied.blocking.at(-1)).toMatch(/^acceptance: it is for .* not this change/);
  });

  it("needs who and why, and a well-formed document", () => {
    const report = { before: { build: "a" }, after: { build: "b" }, blocking: ["x"] } as never;
    expect(() => acceptanceFor(report, " ", "why")).toThrow(/--by/);
    expect(() => acceptanceFor(report, "me", "")).toThrow(/--why/);
    expect(validateAcceptance({ format: "typesys.deploy-acceptance/1", from: "a", to: "b", accepted: [{ blocking: "x", by: "me", why: " " }] })).toEqual(["accepted[0]: needs blocking, by and why"]);
    expect(validateAcceptance({})[0]).toMatch(/^must be a typesys\.deploy-acceptance\/1 document/);
  });

  it("typesys deploy check writes an acceptance that, passed back, lets the change through", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "typesys-accept-"));
    try {
      const nextFile = path.join(dir, "airforce.deployment.json");
      cpSync(path.join(root, "examples/upgrades/airforce-viewers-read-maintenance.deployment.json"), nextFile);
      const acc = path.join(dir, "acceptance.json");
      const packsDir = path.join(root, "packs");
      expect(await deployCommand(["check", airforceFile, nextFile, "--packs-dir", packsDir, "--write-acceptance", acc, "--by", "R. Owner", "--why", "meant"])).toBe(1);
      expect(JSON.parse(readFileSync(acc, "utf8"))).toMatchObject({ format: "typesys.deploy-acceptance/1" });
      expect(await deployCommand(["check", airforceFile, nextFile, "--packs-dir", packsDir, "--accept", acc])).toBe(0);
      expect(await deployCommand(["check", airforceFile, airforceFile, "--packs-dir", packsDir, "--accept", acc])).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the first answers a server gives (ADR-0112)", () => {
  const servings: { close(): Promise<void> }[] = [];
  afterAll(async () => {
    await Promise.allSettled(servings.map((s) => s.close()));
  });

  it("GET / and GET /api say where to start, without a token", async () => {
    const s = await serve({ file: airforceFile, port: 0 });
    servings.push(s);
    const index = (await (await fetch(`http://localhost:${s.port}/`)).json()) as Record<string, unknown>;
    expect(index).toMatchObject({ deployment: "airforce", build: s.host.build, mcp: "/mcp", api: "/api", openapi: "/api/openapi.json" });
    const api = (await (await fetch(`http://localhost:${s.port}/api`)).json()) as { routes: Record<string, string> };
    expect(api.routes.query).toContain("POST /api/query");
    expect(api.routes.object).toBe("GET /api/objects/{type}/{id}");
  });

  it("a malformed query says what each unknown field is called and what a query looks like", async () => {
    const h = await host();
    try {
      const err = await h.runtime.query({ typeName: "airforce.Aircraft", where: { tailNumber: "x" } } as never, h.personas.maintainer!).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(InvalidInputError);
      const message = (err as Error).message;
      expect(message).toContain('"typeName" is "type" in a query');
      expect(message).toContain('"where" is "filter" in a query');
      expect(message).toContain('a query looks like {"type": "<Type>", "filter": {"property": "<name>", "operator": "eq", "value": "..."}, "limit": 10}');
      const odd = await h.runtime.query({ type: "airforce.Aircraft", bogus: 1 } as never, h.personas.maintainer!).catch((e: unknown) => e);
      expect((odd as Error).message).toContain('"bogus" is not a query field (type, filter, search, sort, select, include, includeProvenance, limit, cursor)');
    } finally {
      await h.close();
    }
  });

  it("a token that names an undeclared persona shows the persona's shape", () => {
    const d = { ...airforceDeployment, identity: { kind: "tokens", tokens: { "t-1": "auditor" } } } as Deployment;
    expect(validateDeployment(d)).toContain(
      'identity.tokens: token "t-1…" names persona "auditor", which personas does not declare: add "personas": { "auditor": { "subjectId": "...", "roles": ["..."], "attributes": {} } }'
    );
  });
});

describe("typesys dev (ADR-0112)", () => {
  it("prints each persona's token, a first call and the MCP line, rebuilds on change, and keeps the last good build when a change does not build", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "typesys-dev-"));
    const file = path.join(dir, "airforce.deployment.json");
    cpSync(airforceFile, file);
    cpSync(path.join(root, "packs"), path.join(dir, "packs"), { recursive: true });
    cpSync(testsFileFor(airforceFile), testsFileFor(file));
    const out: string[] = [];
    const err: string[] = [];
    const session = await startDev({ file, port: 0, watch: false, out: (s) => out.push(s), err: (s) => err.push(s) });
    try {
      const first = session.serving()!;
      expect(first).toBeDefined();
      const text = out.join("\n");
      expect(text).toContain("airforce is serving");
      expect(text).toContain("maintainer demo-maintainer-token   roles: maintainer");
      expect(text).toContain(`claude mcp add --transport http airforce http://localhost:${first.port}/mcp --header "Authorization: Bearer demo-maintainer-token"`);
      expect(text).toContain("PASS: 6 passed, 0 failed");
      expect(await welcome(first)).toContain(`curl -s -X POST http://localhost:${first.port}/api/query`);

      // A change that does not build: reported, and the last good build keeps serving on the same port.
      const good = readFileSync(file, "utf8");
      writeFileSync(file, good.replace('"airforce.read-aircraft"', '"airforce.read-aircraftt"'));
      expect(await session.rebuild()).toBe(false);
      expect(err.join("\n")).toContain("The deployment does not build");
      expect(session.serving()).toBe(first);
      expect((await fetch(`http://localhost:${first.port}/healthz`)).status).toBe(200);

      // A change that builds and breaks a policy test: served, on the same port, with the failing test shown.
      const widened = JSON.parse(good) as Deployment;
      (widened.policies as Record<string, unknown>)["airforce.maintainer-only"] = { role: ["maintainer", "viewer", "ai-enclave"] };
      writeFileSync(file, JSON.stringify(widened));
      expect(await session.rebuild()).toBe(true);
      const second = session.serving()!;
      expect(second.host.build).not.toBe(first.host.build);
      expect(second.port).toBe(first.port);
      expect(out.join("\n")).toMatch(/✗ a viewer reads AF86-0147[^\n]*\n\s+maintenanceStatus was returned/);
    } finally {
      await session.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a deployment that does not build when dev starts leaves nothing serving and says why", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "typesys-dev-"));
    const file = path.join(dir, "bad.deployment.json");
    writeFileSync(file, JSON.stringify({ ...airforceDeployment, policies: {} }));
    cpSync(path.join(root, "packs"), path.join(dir, "packs"), { recursive: true });
    const err: string[] = [];
    const session = await startDev({ file, port: 0, watch: false, out: () => undefined, err: (s) => err.push(s) });
    try {
      expect(session.serving()).toBeUndefined();
      expect(err.join("\n")).toContain("The deployment does not build");
    } finally {
      await session.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a DeploymentError from a missing pack names where it looked", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "typesys-dev-"));
    try {
      const file = path.join(dir, "airforce.deployment.json");
      cpSync(airforceFile, file);
      const err = await serve({ file, port: 0 }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DeploymentError);
      expect((err as DeploymentError).problems[0]).toMatch(/^pack core@1\.0\.0: not found at /);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
