import type { Server } from "node:http";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { ExecutionPlan } from "@typesys/core";
import { buildAirforceTestbed, resolveDemoIdentity, type AirforceTestbed } from "@typesys/domain-airforce";
import { createStudioApp } from "../src/index.js";
import { applySuggestion, columnKeys, formatCell, parseQuery, planLines, pointerTokens } from "../src/client/logic.js";

let testbed: AirforceTestbed;
const servers: Server[] = [];

async function serve(opts: Partial<Parameters<typeof createStudioApp>[0]> = {}): Promise<string> {
  const app = createStudioApp({ backend: testbed, identityResolver: resolveDemoIdentity, ...opts });
  const server = await new Promise<Server>((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

beforeAll(async () => {
  testbed = await buildAirforceTestbed({ mockRestLatencyMs: 0 });
});
afterAll(() => Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r())))));

const post = (base: string, p: string, body: unknown, token?: string) =>
  fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });

describe("the Studio server (ADR-0061)", () => {
  it("serves the client under a policy that lets the page load only its own script, style and API", async () => {
    const dir = path.resolve(import.meta.dirname, "fixtures/client");
    const base = await serve({ clientDir: dir });
    const page = await fetch(`${base}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<div id="root">');
    const csp = page.headers.get("content-security-policy") ?? "";
    for (const directive of ["default-src 'none'", "script-src 'self'", "style-src 'self'", "connect-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'none'"])
      expect(csp).toContain(directive);
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|\*/);
    // Every source the policy allows is the page's own (or an inline data: image): no other origin, of any kind.
    const sources = csp.split(";").flatMap((d) => d.trim().split(/\s+/).slice(1));
    expect(sources.filter((s) => !["'none'", "'self'", "data:"].includes(s))).toEqual([]);
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    expect(page.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    expect((await fetch(`${base}/studio.js`)).headers.get("content-security-policy")).toBe(csp);
  });

  it("offers demo sign-ins only when given them", async () => {
    const plain = await (await fetch(`${await serve({ clientDir: "/nonexistent" })}/studio/config.json`)).json();
    expect(plain).toEqual({ title: "TypeSys Studio", demo: null });
    const demo = await (await fetch(`${await serve({ title: "Demo", demoTokens: { Viewer: "demo-viewer-token" } })}/studio/config.json`)).json();
    expect(demo).toEqual({ title: "Demo", demo: [{ label: "Viewer", token: "demo-viewer-token" }] });
  });

  it("says the client is not built rather than serving nothing", async () => {
    const res = await fetch(`${await serve({ clientDir: "/nonexistent" })}/`);
    expect(res.status).toBe(503);
    expect(await res.text()).toMatch(/npm run build/);
  });

  it("serves the governed API beside it, answering each caller as the runtime does", async () => {
    const base = await serve({ clientDir: "/nonexistent" });
    const me = async (token?: string) => (await fetch(`${base}/api/me`, token ? { headers: { authorization: `Bearer ${token}` } } : {})).json();
    expect(await me("demo-viewer-token")).toEqual({ subjectId: "user-viewer-1", roles: ["viewer"], clearance: "CUI" });
    expect(await me()).toEqual({ subjectId: "anonymous", roles: [] });
    const q = { type: "airforce.Aircraft", select: ["tailNumber", "deploymentLocation"], limit: 50 };
    const rows = async (token: string) => ((await (await post(base, "/api/query", q, token)).json()) as { items: { values: Record<string, unknown> }[] }).items;
    expect((await rows("demo-maintainer-token")).some((r) => r.values.deploymentLocation !== undefined)).toBe(true);
    expect((await rows("demo-viewer-token")).every((r) => r.values.deploymentLocation === undefined)).toBe(true);
    expect((await post(base, "/api/query", q)).status).toBe(403);
  });

  it("refuses a call from another site's page", async () => {
    const base = await serve({ clientDir: "/nonexistent" });
    const res = await fetch(`${base}/api/me`, { headers: { origin: "https://evil.example" } });
    expect(res.status).toBe(403);
  });
});

describe("the Studio's screen logic", () => {
  it("parses only a JSON object that names a Type", () => {
    expect(parseQuery('{"type":"airforce.Aircraft"}')).toEqual({ ok: true, query: { type: "airforce.Aircraft" } });
    expect(parseQuery("{").ok).toBe(false);
    expect(parseQuery("[]")).toEqual({ ok: false, error: "A query is a JSON object" });
    expect(parseQuery("null")).toEqual({ ok: false, error: "A query is a JSON object" });
    expect(parseQuery('{"limit":1}').ok).toBe(false);
  });

  it("writes a suggestion exactly where the diagnostic points", () => {
    const text = JSON.stringify({ type: "airforce.Aircraft", filter: { and: [{ property: "tailNumbr", operator: "eq", value: "x" }] }, include: [{ relationship: "maintenence" }] });
    const fixed = applySuggestion(applySuggestion(text, { path: "/filter/and/0/property", suggestion: "tailNumber" }), { path: "/include/0/relationship", suggestion: "maintenance" });
    expect(JSON.parse(fixed)).toEqual({ type: "airforce.Aircraft", filter: { and: [{ property: "tailNumber", operator: "eq", value: "x" }] }, include: [{ relationship: "maintenance" }] });
    expect(fixed).toContain('\n  "type"');
    // Escaped pointer tokens (RFC 6901).
    expect(pointerTokens("/a~1b/c~0d")).toEqual(["a/b", "c~d"]);
    expect(JSON.parse(applySuggestion('{"type":"t","select":{"a/b":"x"}}', { path: "/select/a~1b", suggestion: "y" }))).toEqual({ type: "t", select: { "a/b": "y" } });
  });

  it("leaves the text alone when the suggestion no longer fits it", () => {
    const text = '{"type":"airforce.Aircraft","select":["tailNumber"]}';
    expect(applySuggestion(text, { path: "/select/0" })).toBe(text);
    expect(applySuggestion(text, { path: "/select/3", suggestion: "x" })).toBe(text);
    expect(applySuggestion(text, { path: "/sort/0/property", suggestion: "x" })).toBe(text);
    expect(applySuggestion(text, { path: "/select", suggestion: "x" })).toBe(text);
    expect(applySuggestion(text, { path: "", suggestion: "x" })).toBe(text);
    expect(applySuggestion("{", { path: "/type", suggestion: "x" })).toBe("{");
    expect(applySuggestion('{"type":"t","toString":"x"}', { path: "/constructor/name", suggestion: "x" })).toBe('{"type":"t","toString":"x"}');
  });

  it("states each step of a real plan for the caller", async () => {
    const base = await serve({ clientDir: "/nonexistent" });
    const query = { type: "airforce.Aircraft", filter: { and: [{ property: "status", operator: "eq", value: "active" }, { property: "needsAttention", operator: "eq", value: true }] }, select: ["tailNumber"] };
    const plan = (await (await post(base, "/api/query/explain", query, "demo-viewer-token")).json()) as ExecutionPlan;
    const lines = planLines(plan);
    expect(lines.length).toBeGreaterThanOrEqual(plan.steps.length);
    expect(lines.slice(0, plan.steps.length).every((l, i) => l.startsWith(`${i + 1}. `))).toBe(true);
    const text = lines.join("\n");
    expect(text).toMatch(/Scan .*filtered in the source by status eq "active"/);
    expect(text).toMatch(/Filter after computing by needsAttention eq true/);
    expect(text).toMatch(/Return only tailNumber/);
    for (const note of plan.notes) expect(lines).toContain(note);
  });

  it("shows a withheld or unset value as an empty cell, and every key the rows carry", () => {
    expect(formatCell(undefined)).toBe("");
    expect(formatCell(null)).toBe("");
    expect(formatCell(0)).toBe("0");
    expect(formatCell(false)).toBe("false");
    expect(formatCell("x")).toBe("x");
    expect(formatCell({ a: 1 })).toBe('{"a":1}');
    expect(columnKeys([{ values: { b: 1 } }, { values: { a: 1, b: 2 } }], ["c"])).toEqual(["c", "b", "a"]);
  });
});
