import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { callEngineerTool, createEngineerServer, engineerCommand, insideRoot } from "../src/index.js";

/** The loop's other two surfaces (ADR-0071): `typesys engineer` and the MCP tools return what the library does. */
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../..");
const MISSION = "examples/missions/component-replacement/mission.json";

describe("typesys engineer (CLI)", () => {
  it("plan --json prints the plan and exits 0; a missing argument prints usage and exits 1", async () => {
    const lines: string[] = [];
    expect(await engineerCommand(["plan", path.join(repo, MISSION), "--json"], (s) => lines.push(s))).toBe(0);
    expect(JSON.parse(lines[0]!)).toMatchObject({ mission: "component-replacement", ok: true });
    const usage: string[] = [];
    expect(await engineerCommand(["scaffold", path.join(repo, MISSION)], (s) => usage.push(s))).toBe(1);
    expect(usage[0]).toMatch(/^typesys engineer/);
  });

  it("an unreadable mission is a diagnostic and exit 1, not a crash", async () => {
    const lines: string[] = [];
    expect(await engineerCommand(["plan", path.join(repo, "no-such-mission.json"), "--json"], (s) => lines.push(s))).toBe(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ ok: false, diagnostics: [{ code: "invalid-mission" }] });
  });
});

describe("the engineer MCP tools", () => {
  it("lists plan, scaffold and verify, and plans the mission through the protocol", async () => {
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1" });
    await Promise.all([createEngineerServer(repo).connect(a), client.connect(b)]);
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["typesys_engineer_plan", "typesys_engineer_scaffold", "typesys_engineer_verify"]);
    const result = await client.callTool({ name: "typesys_engineer_plan", arguments: { mission: MISSION } });
    expect(result.isError).toBe(false);
    expect(JSON.parse((result.content as { text: string }[])[0]!.text)).toMatchObject({ mission: "component-replacement", ok: true });
    await client.close();
  });

  it("never reads or writes outside its root", async () => {
    expect(() => insideRoot(repo, "../elsewhere")).toThrow(/outside/);
    expect(() => insideRoot(repo, "/etc/passwd")).toThrow(/outside/);
    expect(insideRoot(repo, MISSION)).toBe(path.join(repo, MISSION));
    const out = await callEngineerTool(repo, "typesys_engineer_scaffold", { mission: MISSION, out: "../escaped" });
    expect(out).toMatchObject({ ok: false, error: expect.stringMatching(/outside/) as string });
    expect(await callEngineerTool(repo, "typesys_engineer_verify", { dir: "/tmp" })).toMatchObject({ ok: false, error: expect.stringMatching(/outside/) as string });
  });
});
