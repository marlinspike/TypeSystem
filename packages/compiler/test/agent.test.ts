import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { appCommand, callAppTool, diffApps, type AppSpec } from "../src/index.js";
import { squadronDir, WORK } from "./apps.js";
import { squadronApp } from "./fixtures.js";

/**
 * What an agent works with (ADR-0085): the language as data, explanations
 * of every code, structured diagnostics, a semantic diff with its impact,
 * and the same answers through MCP, confined to a root.
 */
const run = async (argv: string[]) => {
  let printed = "";
  const code = await appCommand([...argv, "--json"], (s) => (printed = s));
  return { code, out: JSON.parse(printed) as Record<string, unknown> };
};
type Mutable = { pages: { layout: { children: Record<string, unknown>[] } }[]; flows: { ground: { version: string; steps: Record<string, unknown>[] } }; acceptance: { id: string }[] };
const edit = (f: (app: Mutable) => void): AppSpec => {
  const app = squadronApp() as unknown as Mutable;
  f(app);
  return app as unknown as AppSpec;
};

describe("diffApps", () => {
  it("reports nothing for the same application", () => {
    const d = diffApps(squadronApp(), squadronApp());
    expect(d.changes).toEqual([]);
    expect(d.impact.checks).toEqual([]);
  });

  it("names a changed node by its page and id, and the screen check that sees it", () => {
    const after = edit((a) => (a.pages[0]!.layout.children[0]!.label = "Aircraft needing attention"));
    const d = diffApps(squadronApp(), after);
    expect(d.changes).toEqual([expect.objectContaining({ change: "changed", what: "node", name: "Board/attention-count", at: "/pages/0/layout/children/0", detail: "metric: label" })]);
    expect(d.impact.checks).toEqual(["board-shows-attention"]);
  });

  it("warns when a flow's steps change and its version does not", () => {
    const after = edit((a) => (a.flows.ground.steps[3]!.message = "the aircraft is fully operational"));
    const d = diffApps(squadronApp(), after);
    const flow = d.changes.find((c) => c.what === "flow")!;
    expect(flow.risk).toContain("Give it a new version");
    expect(d.changes.find((c) => c.what === "step")).toMatchObject({ name: "ground/degraded", detail: "check: message" });
    expect(d.impact.checks).toEqual(expect.arrayContaining(["maintainer-grounds", "lead-approves", "board-shows-attention"]));
    const versioned = edit((a) => {
      a.flows.ground.version = "1.1.0";
      a.flows.ground.steps[3]!.message = "the aircraft is fully operational";
    });
    expect(diffApps(squadronApp(), versioned).changes.find((c) => c.what === "flow")).toMatchObject({ detail: "version" });
    expect(diffApps(squadronApp(), versioned).changes.find((c) => c.what === "flow")!.risk).toBeUndefined();
  });

  it("names removed nodes and steps with what they break", () => {
    const after = edit((a) => {
      a.pages[0]!.layout.children.splice(3, 1);
      a.flows.ground.version = "2.0.0";
      a.flows.ground.steps.splice(2, 1);
    });
    const d = diffApps(squadronApp(), after);
    expect(d.changes.find((c) => c.name === "Board/approvals")).toMatchObject({ change: "removed" });
    expect(d.changes.find((c) => c.name === "Board/approvals")!.risk).toContain("screen check");
    expect(d.changes.find((c) => c.name === "ground/poorParts")).toMatchObject({ change: "removed", what: "step" });
  });
});

describe("typesys app", () => {
  it("prints the catalog and explains every code", async () => {
    const cat = await run(["catalog"]);
    expect(cat.code).toBe(0);
    expect(Object.keys(cat.out.nodes as object)).toEqual(expect.arrayContaining(["table", "map", "graph", "approvals", "assistant", "custom"]));
    const explained = await run(["explain", "unreviewed-ai-output"]);
    expect(explained.out.resolve).toContain("approval");
    expect((await run(["explain", "no-such-code"])).code).toBe(1);
  });

  it("checks a directory, with diagnostics at JSON Pointers, and the callers each policy admits", async () => {
    const dir = await squadronDir("cli-check");
    const ok = await run(["check", dir]);
    expect(ok.code).toBe(0);
    expect((ok.out.flows as Record<string, { admitted: unknown }>).ground!.admitted).toEqual({ start: ["maintainer", "lead"], approvals: { leadApproval: ["lead"] } });
    const bad = await squadronDir("cli-check-bad", edit((a) => (a.flows.ground.steps[6]!.action = "CreateMaintenanceWorkorder")));
    const r = await run(["check", bad]);
    expect(r.code).toBe(1);
    expect((r.out.diagnostics as { code: string; at: string; hint?: string }[]).find((d) => d.code === "unknown-action")).toMatchObject({ at: "/flows/ground/steps/6/action", hint: 'did you mean "CreateMaintenanceWorkOrder"?' });
  });

  it("diffs against an earlier app.json, naming the generated files that change", async () => {
    const dir = await squadronDir("cli-diff", edit((a) => (a.pages[0]!.layout.children[0]!.label = "Attention")));
    const before = path.join(WORK, "cli-diff.before.json");
    await writeFile(before, JSON.stringify(squadronApp()));
    const r = await run(["diff", dir, "--against", before]);
    expect(r.code).toBe(0);
    expect((r.out.impact as { files: string[] }).files).toEqual(["src/generated/pages/Board.tsx"]);
  });

  it("gives the model context for the requirement, as a caller", async () => {
    const dir = await squadronDir("cli-context");
    const r = await run(["context", dir, "--as", "viewer"]);
    expect(r.code).toBe(0);
    expect(r.out.as).toBe("user-viewer-1");
    expect((r.out.types as { name: string }[]).map((t) => t.name)).toContain("airforce.Aircraft");
  });
});

describe("the MCP tools", () => {
  it("answer as the CLI does, and refuse a path outside their root", async () => {
    await squadronDir("mcp-root/app");
    const root = path.join(WORK, "mcp-root");
    expect((await callAppTool(root, "typesys_app_check", { dir: "app" })).ok).toBe(true);
    const outside = await callAppTool(root, "typesys_app_check", { dir: "../cli-check" });
    expect(outside.ok).toBe(false);
    expect(String(outside.error)).toMatch(/outside|root/);
    expect((await callAppTool(root, "typesys_app_nonsense", { dir: "app" })).ok).toBe(false);
    await writeFile(path.join(root, "mission.json"), await readFile(path.resolve(WORK, "../../../examples/missions/sortie-readiness/mission.json"), "utf8"));
    const migrated = await callAppTool(root, "typesys_app_migrate", { mission: "mission.json", dir: "migrated", force: true });
    expect(migrated.ok).toBe(true);
    expect((await callAppTool(root, "typesys_app_migrate", { mission: "../outside.json", dir: "migrated" })).ok).toBe(false);
  });
});
