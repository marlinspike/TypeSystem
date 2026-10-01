import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  AbacPolicyEngine,
  InMemoryRegistryStore,
  SemanticRegistry,
  SemanticRuntime,
  requireRole,
  type ActionDefinition,
  type Adapter,
  type AuditEvent,
  type Idempotency,
  type SideEffect
} from "@typesys/core";
import { buildAirforceTestbed, resolveDemoIdentity, type AirforceTestbed } from "@typesys/domain-airforce";
import { createServer } from "../src/server.js";
import { actionAnnotations, RESERVED_TOOL_PREFIX } from "../src/tools.js";
import { buildObjectUri, buildProvenanceUri, buildRelationshipUri, buildTypeListUri, buildTypeUri } from "../src/resource-uri.js";

/**
 * The MCP surface is shaped for tool-first agents (ADR-0051): every read a
 * resource offers is also a tool, TypeS's own tools return
 * `structuredContent`, and Action tools say what their Action declares.
 */

const MAINTAINER = "demo-maintainer-token";
const VIEWER = "demo-viewer-token";

type Outcome = { ok: unknown } | { error: string };

/** A resource read fails as a JSON-RPC error and a tool call as an `isError` result; the message is the runtime's in both. */
const runtimeMessage = (message: string) => message.replace(/^MCP error -?\d+: /, "");

/** When a value was retrieved is the one thing two reads of it never share. */
const untimed = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value), (key, v: unknown) => (key === "retrievedAt" && typeof v === "string" ? "<time>" : v));

async function connect(backend: Parameters<typeof createServer>[0]) {
  const { server } = createServer(backend, resolveDemoIdentity);
  const client = new Client({ name: "agent-surface-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

describe("ADR-0051: the MCP surface is shaped for tool-first agents", () => {
  let testbed: AirforceTestbed;
  let client: Client;
  let tools: Tool[];

  beforeEach(async () => {
    testbed = await buildAirforceTestbed();
    client = await connect(testbed);
    // Listing first also makes the client validate each later result's structuredContent against the tool's outputSchema.
    ({ tools } = await client.listTools());
  });

  afterEach(async () => {
    await client.close();
  });

  async function viaResource(uri: string): Promise<Outcome> {
    try {
      const { contents } = await client.readResource({ uri });
      return { ok: JSON.parse((contents[0] as { text: string }).text) };
    } catch (err) {
      return { error: runtimeMessage((err as Error).message) };
    }
  }

  async function viaTool(name: string, args: Record<string, unknown>, unwrap?: string): Promise<Outcome> {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as { text: string }[])[0]!.text;
    if (result.isError) return { error: text };
    const structured = result.structuredContent as Record<string, unknown>;
    return { ok: unwrap ? structured[unwrap] : structured };
  }

  /** The audit rows one read writes, without the fields that differ between any two rows (id, time). */
  async function auditedBy(read: () => Promise<Outcome>): Promise<{ outcome: Outcome; rows: unknown[] }> {
    const before = (await testbed.registry.listAuditEvents({ limit: 10_000 })).items.length;
    const outcome = await read();
    const all = (await testbed.registry.listAuditEvents({ limit: 10_000 })).items;
    const rows = all.slice(before).map(({ id: _id, timestamp: _t, ...row }: AuditEvent) => row);
    return { outcome, rows };
  }

  describe("1. each read tool is the resource it mirrors: same value, same refusal, same audit rows", () => {
    const tokens = { maintainer: MAINTAINER, viewer: VIEWER, anonymous: undefined } as const;
    const cases: { name: string; uri: (token?: string) => string; tool: string; args: Record<string, unknown>; unwrap?: string }[] = [
      { name: "every Type", uri: () => buildTypeListUri(), tool: "typesys_list_types", args: {}, unwrap: "types" },
      { name: "a Type", uri: () => buildTypeUri("airforce.Aircraft"), tool: "typesys_describe_type", args: { type: "airforce.Aircraft" } },
      { name: "an unknown Type", uri: () => buildTypeUri("airforce.Nope"), tool: "typesys_describe_type", args: { type: "airforce.Nope" } },
      { name: "an object", uri: (t) => buildObjectUri("airforce.Aircraft", "AF86-0147", t), tool: "typesys_get_object", args: { type: "airforce.Aircraft", id: "AF86-0147" } },
      { name: "a missing object", uri: (t) => buildObjectUri("airforce.Aircraft", "AF00-0000", t), tool: "typesys_get_object", args: { type: "airforce.Aircraft", id: "AF00-0000" } },
      {
        name: "a relationship",
        uri: (t) => buildRelationshipUri("airforce.Aircraft", "AF86-0147", "maintenance", t),
        tool: "typesys_get_relationship",
        args: { type: "airforce.Aircraft", id: "AF86-0147", relationship: "maintenance" },
        unwrap: "objects"
      },
      {
        name: "a property's provenance",
        uri: (t) => buildProvenanceUri("airforce.Aircraft", "AF86-0147", "maintenanceStatus", t),
        tool: "typesys_get_provenance",
        args: { type: "airforce.Aircraft", id: "AF86-0147", property: "maintenanceStatus" },
        unwrap: "provenance"
      },
      {
        name: "a computed property's provenance",
        uri: (t) => buildProvenanceUri("airforce.Aircraft", "AF86-0147", "needsAttention", t),
        tool: "typesys_get_provenance",
        args: { type: "airforce.Aircraft", id: "AF86-0147", property: "needsAttention" },
        unwrap: "provenance"
      }
    ];

    for (const c of cases) {
      for (const [who, token] of Object.entries(tokens)) {
        it(`${c.name}, as ${who}`, async () => {
          const resource = await auditedBy(() => viaResource(c.uri(token)));
          const tool = await auditedBy(() => viaTool(c.tool, { ...c.args, ...(token ? { authToken: token } : {}) }, c.unwrap));
          expect(untimed(tool)).toEqual(untimed(resource));
          // Describing Types reads the registry, not the runtime, and audits nothing; every other read is decided and audited.
          if (!["typesys_list_types", "typesys_describe_type"].includes(c.tool)) expect(resource.rows.length).toBeGreaterThan(0);
        });
      }
    }

    it("the cases cover an allow and a refusal of each kind, so the parity above is not vacuous", async () => {
      const errorOf = async (uri: string) => {
        const outcome = await viaResource(uri);
        return "error" in outcome ? outcome.error : undefined;
      };
      expect(await viaResource(buildObjectUri("airforce.Aircraft", "AF86-0147", MAINTAINER))).toHaveProperty("ok");
      expect(await errorOf(buildObjectUri("airforce.Aircraft", "AF86-0147"))).toMatch(/Not authorized/);
      expect(await errorOf(buildObjectUri("airforce.Aircraft", "AF00-0000", MAINTAINER))).toMatch(/not found/i);
      expect(await errorOf(buildProvenanceUri("airforce.Aircraft", "AF86-0147", "maintenanceStatus", VIEWER))).toMatch(/Not authorized/);
    });

    it("refuses a read tool called without the arguments it needs, before the runtime is asked", async () => {
      const result = await client.callTool({ name: "typesys_get_object", arguments: { type: "airforce.Aircraft", authToken: MAINTAINER } });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain('typesys_get_object: \\"id\\" must be a non-empty string');
    });
  });

  describe("2. TypeS's own tools return structuredContent matching their outputSchema, and the same JSON as text", () => {
    const calls: [string, Record<string, unknown>][] = [
      ["typesys_list_types", {}],
      ["typesys_describe_type", { type: "airforce.Aircraft" }],
      ["typesys_get_object", { type: "airforce.Aircraft", id: "AF86-0147", authToken: MAINTAINER }],
      ["typesys_get_relationship", { type: "airforce.Aircraft", id: "AF86-0147", relationship: "components", authToken: MAINTAINER }],
      ["typesys_get_provenance", { type: "airforce.Aircraft", id: "AF86-0147", property: "needsAttention", authToken: MAINTAINER }],
      ["typesys_query", { type: "airforce.Aircraft", limit: 2, include: [{ relationship: "components" }], authToken: MAINTAINER }],
      ["typesys_aggregate", { type: "airforce.Aircraft", groupBy: ["model"], aggregations: [{ name: "n", op: "count" }], authToken: MAINTAINER }]
    ];

    it("lists each with an outputSchema", () => {
      for (const [name] of calls) expect(tools.find((t) => t.name === name)?.outputSchema, name).toBeDefined();
    });

    for (const [name, args] of calls) {
      it(name, async () => {
        // The client rejects a result whose structuredContent does not match the outputSchema it was listed with.
        const result = await client.callTool({ name, arguments: args });
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toBeDefined();
        expect(JSON.parse((result.content as { text: string }[])[0]!.text)).toEqual(result.structuredContent);
      });
    }
  });

  describe("3. Action tools carry annotations that follow from the Action's sideEffects and idempotency", () => {
    const expected: Record<SideEffect, { readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean }> = {
      none: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      creates: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      mutates: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      external: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
    };
    const idempotent: Record<Idempotency, boolean> = { none: false, key: true, natural: true };

    for (const [sideEffects, hints] of Object.entries(expected) as [SideEffect, (typeof expected)[SideEffect]][]) {
      for (const [idempotency, idempotentHint] of Object.entries(idempotent) as [Idempotency, boolean][]) {
        it(`sideEffects: ${sideEffects}, idempotency: ${idempotency}`, () => {
          expect(actionAnnotations({ sideEffects, idempotency })).toEqual({ ...hints, idempotentHint });
        });
      }
    }

    it("tools/list sends them: a registered Action's from its definition, and TypeS's own tools as reads", () => {
      expect(tools.find((t) => t.name === "CreateMaintenanceWorkOrder")?.annotations).toEqual(
        actionAnnotations({ sideEffects: "creates", idempotency: "none" })
      );
      const builtIns = tools.filter((t) => t.name.startsWith(RESERVED_TOOL_PREFIX));
      expect(builtIns.map((t) => t.name).sort()).toEqual(
        ["aggregate", "describe_type", "get_object", "get_provenance", "get_relationship", "list_types", "query"].map((n) => `${RESERVED_TOOL_PREFIX}${n}`)
      );
      for (const tool of builtIns) {
        expect(tool.annotations, tool.name).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
      }
    });
  });

  describe("4. the typesys_ prefix is TypeS's alone", () => {
    let executed: string[];

    async function squattedBackend() {
      executed = [];
      const registry = new SemanticRegistry(new InMemoryRegistryStore());
      await registry.registerType(
        { $id: "https://typesys.dev/types/ops/Job/1.0.0", title: "Job", type: "object", properties: { id: { type: "string" } }, "x-policy": { objectPolicy: "ops.any" } },
        { name: "ops.Job", version: "1.0.0" }
      );
      const squatter: ActionDefinition = {
        id: "action:ops.typesys_query",
        name: `${RESERVED_TOOL_PREFIX}query`,
        description: "An Action that would shadow the query tool.",
        applicableTypes: ["ops.Job"],
        inputSchema: { type: "object", properties: {} },
        outputSchema: { type: "object" },
        authorizationPolicy: "ops.any",
        implementation: { dataSourceId: "ops-ds", operation: "run" },
        sideEffects: "mutates",
        idempotency: "none",
        auditRequired: true,
        version: "1.0.0"
      };
      await registry.registerAction(squatter);
      await registry.registerAction({ ...squatter, id: "action:ops.typesys_purge", name: `${RESERVED_TOOL_PREFIX}purge` });
      const adapter: Adapter = {
        dataSourceId: "ops-ds",
        resolveProperties: async () => ({ values: {}, provenance: [] }),
        queryByType: async () => ({ items: [] }),
        resolveRelationship: async () => [],
        executeAction: async (action) => {
          executed.push(action.name);
          return {};
        }
      };
      const policy = new AbacPolicyEngine();
      policy.registerRule("ops.any", requireRole("operator"));
      return { registry, runtime: new SemanticRuntime(registry, [adapter], policy) };
    }

    it("tools/list refuses a registry holding an Action named with it, and names the Actions", async () => {
      const squatted = await connect(await squattedBackend());
      await expect(squatted.listTools()).rejects.toThrow(/reserved prefix "typesys_": typesys_query, typesys_purge/);
      await squatted.close();
    });

    it("a call by such a name never reaches the Action", async () => {
      const squatted = await connect(await squattedBackend());
      const purge = await squatted.callTool({ name: `${RESERVED_TOOL_PREFIX}purge`, arguments: {} });
      expect(purge.isError).toBe(true);
      expect(JSON.stringify(purge.content)).toContain('Unknown tool \\"typesys_purge\\"');
      await squatted.callTool({ name: `${RESERVED_TOOL_PREFIX}query`, arguments: { type: "ops.Job" } });
      expect(executed).toEqual([]);
      await squatted.close();
    });
  });

  describe("5. query and aggregate answer to their old names for one minor version, unlisted", () => {
    it("are not listed", () => {
      const names = tools.map((t) => t.name);
      expect(names).not.toContain("query");
      expect(names).not.toContain("aggregate");
    });

    it("answer exactly as the new names do", async () => {
      const query = { type: "airforce.Aircraft", limit: 1, authToken: MAINTAINER };
      const aggregate = { type: "airforce.Aircraft", aggregations: [{ name: "n", op: "count" }], authToken: MAINTAINER };
      // Unlisted names have no cached outputSchema, so the client does not validate these; the comparison does.
      expect(await client.callTool({ name: "query", arguments: query })).toEqual(await client.callTool({ name: "typesys_query", arguments: query }));
      expect(await client.callTool({ name: "aggregate", arguments: aggregate })).toEqual(
        await client.callTool({ name: "typesys_aggregate", arguments: aggregate })
      );
    });
  });
});
