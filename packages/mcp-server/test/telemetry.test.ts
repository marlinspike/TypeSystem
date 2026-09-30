import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { trace, context } from "@opentelemetry/api";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { AsyncHooksContextManager } from "@opentelemetry/context-async-hooks";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildAirforceTestbed, resolveDemoIdentity } from "@typesys/domain-airforce";
import type { SemanticRuntimeOptions } from "@typesys/core";
import { createServer } from "../src/server.js";
import { buildObjectUri, buildProvenanceUri, buildRelationshipUri, buildTypeUri, telemetryResourceUri } from "../src/resource-uri.js";

/**
 * ADR-0047: the MCP server's own spans follow the runtime's telemetry
 * policy — and never record the bearer token a resource URI carries, under
 * any policy.
 */
let exporter: InMemorySpanExporter;
beforeAll(() => {
  context.setGlobalContextManager(new AsyncHooksContextManager().enable());
  exporter = new InMemorySpanExporter();
  trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }));
});
afterAll(() => {
  // One process runs every file (`isolate: false`): don't keep recording other files' spans.
  trace.disable();
  context.disable();
});
beforeEach(() => exporter.reset());

const TOKEN = "demo-maintainer-token";
const exported = () =>
  JSON.stringify(exporter.getFinishedSpans().map((s) => ({ name: s.name, attributes: s.attributes, status: s.status, events: s.events.map((e) => ({ name: e.name, attributes: e.attributes })) })));

async function connect(runtimeOptions: SemanticRuntimeOptions) {
  const bundle = createServer(await buildAirforceTestbed({ runtimeOptions }), resolveDemoIdentity);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), bundle.server.connect(serverTransport)]);
  return client;
}

/** Reads that succeed, one that's denied, one the adapter can't find, and one the server doesn't recognize. */
async function everything(client: Client) {
  const settle = (p: Promise<unknown>) => p.then(() => "ok", () => "error");
  return [
    await settle(client.readResource({ uri: buildTypeUri("airforce.Aircraft") })),
    await settle(client.readResource({ uri: buildObjectUri("airforce.Aircraft", "AF86-0147", TOKEN) })),
    await settle(client.readResource({ uri: buildRelationshipUri("airforce.Aircraft", "AF86-0147", "components", TOKEN) })),
    await settle(client.readResource({ uri: buildProvenanceUri("airforce.Aircraft", "AF86-0147", "tailNumber", TOKEN) })),
    await settle(client.readResource({ uri: buildObjectUri("airforce.Aircraft", "AF86-0147") })), // no token: denied
    await settle(client.readResource({ uri: buildObjectUri("airforce.Aircraft", "AF99-9999", TOKEN) })),
    await settle(client.readResource({ uri: `typesys://elsewhere/AF86-0147?token=${TOKEN}` })),
    await settle(client.callTool({ name: "query", arguments: { type: "airforce.Aircraft", authToken: TOKEN } }))
  ];
}

describe("MCP spans and identifiers (ADR-0047)", () => {
  it("attack: the bearer token in a resource URI never reaches a span, even in the clear", async () => {
    const outcomes = await everything(await connect({}));
    expect(outcomes).toContain("error");
    const text = exported();
    expect(text).toContain("AF86-0147"); // clear keeps object ids, as it always has
    expect(text).not.toContain(TOKEN);
  });

  for (const [label, telemetryIdentity] of [
    ['"none"', "none"],
    ["pseudonymous", { mode: "pseudonymous", key: new Uint8Array(32).fill(5) }]
  ] as [string, SemanticRuntimeOptions["telemetryIdentity"]][]) {
    it(`attack: under ${label}, no object id or token reaches the MCP spans or the runtime's beneath them`, async () => {
      const outcomes = await everything(await connect({ telemetryIdentity }));
      expect(outcomes.filter((o) => o === "error").length).toBeGreaterThanOrEqual(2);
      const spans = exporter.getFinishedSpans();
      expect(spans.some((s) => s.name === "mcp.resources/read")).toBe(true);
      expect(spans.some((s) => s.name.startsWith("SemanticRuntime."))).toBe(true);
      expect(exported()).not.toMatch(/AF86-0147|AF99-9999|demo-maintainer-token|user-maintainer/);
      // What stays: which kind of resource, which Type, which relationship.
      expect(spans.map((s) => s.attributes["mcp.resource.uri"]).filter(Boolean)).toEqual(
        expect.arrayContaining(["typesys://objects/airforce.Aircraft/{objectId}", "typesys://objects/airforce.Aircraft/{objectId}/relationships/components", "typesys://{unrecognized}"])
      );
    });
  }

  it("telemetryResourceUri: the path only in the clear; category, Type, and shape when redacting", () => {
    expect(telemetryResourceUri(buildObjectUri("a.T", "id/1", TOKEN), false)).toBe("typesys://objects/a.T/id%2F1");
    expect(telemetryResourceUri(`${buildTypeUri("a.T")}#${TOKEN}`, false)).toBe("typesys://types/a.T");
    expect(telemetryResourceUri(buildProvenanceUri("a.T", "id-1", "x.y", TOKEN), true)).toBe("typesys://objects/a.T/{objectId}/provenance/x.y");
    expect(telemetryResourceUri(buildTypeUri("a.T"), true)).toBe("typesys://types/a.T");
    expect(telemetryResourceUri("typesys://objects/a.T/%E0%A4%A", true)).toBe("typesys://{unparseable}");
    expect(telemetryResourceUri("https://objects/a.T/id-1", true)).toBe("typesys://{unrecognized}");
    expect(telemetryResourceUri("objects/a.T/id-1", true)).toBe("typesys://{unrecognized}"); // no scheme: not a resource URI
  });
});
