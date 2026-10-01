import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  AbacPolicyEngine,
  InMemoryRegistryStore,
  SemanticRegistry,
  SemanticRuntime,
  buildRuntime,
  matchesFilter,
  requireRole,
  type Adapter,
  type AdapterQueryResult,
  type Identity,
  type RelatedRef,
  type ResolvedProperties,
  type SemanticTypeSchema
} from "@typesys/core";
import { createServer } from "../src/server.js";
import { createHttpApp, startHttpServer } from "../src/http-transport.js";
import type { IdentityResolver } from "../src/auth.js";

/**
 * The MCP server serves any registry (ADR-0050). Every test here uses a small fleet domain built from
 * `@typesys/core` alone — nothing of the airforce demo — so a pass means the entry points, not just the handler
 * functions, are free of it.
 */
const DATA: Record<string, Record<string, unknown>> = {
  v1: { id: "v1", name: "Van 1", plateNumber: "FLT-001" },
  v2: { id: "v2", name: "Van 2", plateNumber: "FLT-002" }
};

class FleetAdapter implements Adapter {
  readonly dataSourceId = "fleet-ds";
  private prov(objectId: string, values: Record<string, unknown>) {
    return Object.keys(values).map((field) => ({
      propertyPath: field,
      source: { dataSourceId: this.dataSourceId, system: "fleet", recordId: objectId, field },
      retrievedAt: "2026-01-01T00:00:00.000Z"
    }));
  }
  async resolveProperties(_typeName: string, objectId: string): Promise<ResolvedProperties> {
    const values = DATA[objectId] ?? {};
    return { values: { ...values }, provenance: this.prov(objectId, values) };
  }
  async queryByType(_typeName: string, filter?: Parameters<Adapter["queryByType"]>[1]): Promise<AdapterQueryResult> {
    return {
      items: Object.entries(DATA)
        .filter(([, values]) => matchesFilter(values, filter))
        .map(([objectId, values]) => ({ objectId, values: { ...values }, provenance: this.prov(objectId, values) }))
    };
  }
  async resolveRelationship(): Promise<RelatedRef[]> {
    return [];
  }
  async executeAction(): Promise<unknown> {
    throw new Error("no actions");
  }
}

const dispatcher: Identity = { subjectId: "dana", roles: ["dispatcher"], attributes: {} };
const anonymous: Identity = { subjectId: "anonymous", roles: [], attributes: {} };

/** The one place identity comes from: nothing is assumed about which tokens exist. */
const resolveFleetIdentity: IdentityResolver = async (token) => (token === "dispatcher-token" ? dispatcher : anonymous);

const VEHICLE: SemanticTypeSchema = {
  $id: "https://typesys.dev/types/fleet/Vehicle/1.0.0",
  title: "Vehicle",
  type: "object",
  properties: { id: { type: "string" }, name: { type: "string" }, plateNumber: { type: "string" } },
  "x-policy": { objectPolicy: "fleet.read-vehicle" }
};

/** A registry and runtime for a domain with nothing in common with the airforce demo. */
async function fleetBackend() {
  const registry = new SemanticRegistry(new InMemoryRegistryStore());
  await registry.registerType(VEHICLE, { name: "fleet.Vehicle", version: "1.0.0" });
  await registry.registerMapping({ id: "map-vehicle", typeName: "fleet.Vehicle", target: "property", targetName: "*", dataSourceId: "fleet-ds", operation: "get", resolutionMode: "live" });
  const policy = new AbacPolicyEngine();
  policy.registerRule("fleet.read-vehicle", requireRole("dispatcher"));
  return { registry, runtime: new SemanticRuntime(registry, [new FleetAdapter()], policy) };
}

async function connect(server: { connect: (transport: never) => Promise<void> }) {
  const client = new Client({ name: "generic-backend-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport as never)]);
  return client;
}

const textOf = (result: unknown) => JSON.stringify(result);

describe("The MCP server serves any registry (ADR-0050)", () => {
  describe("createServer over a backend that is not the airforce demo", () => {
    it("lists the backend's Types as resources, and nothing it does not hold", async () => {
      const { server } = createServer(await fleetBackend(), resolveFleetIdentity);
      const client = await connect(server);
      const { resources } = await client.listResources();

      const uris = resources.map((r) => r.uri);
      expect(uris).toContain("typesys://types");
      expect(uris).toContain("typesys://types/fleet.Vehicle");
      expect(uris.filter((u) => u.startsWith("typesys://objects/"))).toEqual([]); // no object resource is invented
      expect(JSON.stringify(resources)).not.toMatch(/airforce|Aircraft|AF86/i);
      await client.close();
    });

    it("reads an object with the identity the resolver gives, and refuses the one it does not", async () => {
      const { server } = createServer(await fleetBackend(), resolveFleetIdentity);
      const client = await connect(server);

      const read = await client.readResource({ uri: "typesys://objects/fleet.Vehicle/v1?token=dispatcher-token" });
      expect(JSON.stringify(read.contents)).toContain("FLT-001");
      await expect(client.readResource({ uri: "typesys://objects/fleet.Vehicle/v1" })).rejects.toThrow(/Not authorized: read fleet\.Vehicle\/v1/);
      await client.close();
    });

    it("runs the generic query tool against it", async () => {
      const { server } = createServer(await fleetBackend(), resolveFleetIdentity);
      const client = await connect(server);

      const ok = await client.callTool({ name: "typesys_query", arguments: { type: "fleet.Vehicle", filter: { property: "plateNumber", operator: "eq", value: "FLT-002" }, authToken: "dispatcher-token" } });
      expect(ok.isError).not.toBe(true);
      expect(textOf(ok)).toContain("v2");
      const refused = await client.callTool({ name: "typesys_query", arguments: { type: "fleet.Vehicle" } });
      expect(refused.isError).toBe(true);
      expect(textOf(refused)).toContain("Not authorized: read fleet.Vehicle");
      await client.close();
    });

    it("announces the name and version it is given, and a default otherwise", async () => {
      const backend = await fleetBackend();
      const named = await connect(createServer(backend, resolveFleetIdentity, { name: "fleet", version: "9.9.9" }).server);
      expect(named.getServerVersion()).toMatchObject({ name: "fleet", version: "9.9.9" });
      await named.close();

      const defaulted = await connect(createServer(backend, resolveFleetIdentity).server);
      expect(defaulted.getServerVersion()).toMatchObject({ name: "typesys-mcp-server", version: "0.1.0" });
      await defaulted.close();
    });

    it("hands back the backend it was given, with whatever else it carries", async () => {
      const backend = { ...(await fleetBackend()), marker: 42 };
      const bundle = createServer(backend, resolveFleetIdentity);
      expect(bundle.marker).toBe(42);
      expect(bundle.registry).toBe(backend.registry);
      expect(bundle.runtime).toBe(backend.runtime);
    });

    it("takes what buildRuntime returns, as is", async () => {
      const built = await buildRuntime({ manifests: [], adapters: [new FleetAdapter()], policyRules: {} });
      expect(() => createServer(built, resolveFleetIdentity)).not.toThrow();
    });
  });

  describe("attack: a server built without what it cannot assume does not start", () => {
    it("createServer without a resolver throws, rather than falling back to an identity of its own", async () => {
      const backend = await fleetBackend();
      expect(() => (createServer as (b: unknown) => unknown)(backend)).toThrow(TypeError);
      expect(() => (createServer as (b: unknown) => unknown)(backend)).toThrow(/identity resolver/i);
      expect(() => (createServer as (b: unknown, r: unknown) => unknown)(backend, "demo-maintainer-token")).toThrow(/identity resolver/i);
    });

    it("createServer without a backend throws", () => {
      expect(() => (createServer as (b: unknown, r: unknown) => unknown)(undefined, resolveFleetIdentity)).toThrow(/backend/i);
      expect(() => (createServer as (b: unknown, r: unknown) => unknown)({ registry: {} }, resolveFleetIdentity)).toThrow(/backend/i);
    });

    it("createHttpApp and startHttpServer refuse a missing backend or resolver", async () => {
      const backend = await fleetBackend();
      const build = createHttpApp as (o?: unknown) => unknown;
      expect(() => build()).toThrow(TypeError);
      expect(() => build({ backend })).toThrow(/identity resolver/i);
      expect(() => build({ identityResolver: resolveFleetIdentity })).toThrow(/backend/i);
      expect(() => (startHttpServer as (p: number, o?: unknown) => unknown)(0)).toThrow(TypeError);
    });
  });

  describe("createHttpApp over that backend", () => {
    async function serve(backend: Awaited<ReturnType<typeof fleetBackend>>) {
      const running = await startHttpServer(0, { backend, identityResolver: resolveFleetIdentity });
      const open = async (headers: Record<string, string> = {}) => {
        const client = new Client({ name: "generic-backend-http-test", version: "0.0.0" });
        await client.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${running.port}/mcp`), { requestInit: { headers } }));
        return client;
      };
      return { running, open };
    }

    it("serves the backend's Types and reads its objects under the header's identity", async () => {
      const { running, open } = await serve(await fleetBackend());
      try {
        const anon = await open();
        expect((await anon.listResources()).resources.some((r) => r.uri === "typesys://types/fleet.Vehicle")).toBe(true);
        await expect(anon.readResource({ uri: "typesys://objects/fleet.Vehicle/v1" })).rejects.toThrow(/Not authorized/);
        await anon.close();

        const authed = await open({ Authorization: "Bearer dispatcher-token" });
        expect(JSON.stringify((await authed.readResource({ uri: "typesys://objects/fleet.Vehicle/v1" })).contents)).toContain("FLT-001");
        await authed.close();
      } finally {
        await running.close();
      }
    });

    it("attack: the header is the authority — an in-band token cannot override it, in either direction", async () => {
      const { running, open } = await serve(await fleetBackend());
      try {
        // A dispatcher's header; an in-band token that would resolve to anonymous. The header wins: allowed.
        const headerWins = await open({ Authorization: "Bearer dispatcher-token" });
        const allowed = await headerWins.callTool({ name: "typesys_query", arguments: { type: "fleet.Vehicle", authToken: "someone-else" } });
        expect(allowed.isError).not.toBe(true);
        await headerWins.close();

        // A bad header; an in-band token that would resolve to the dispatcher. The header still wins: refused.
        const headerLoses = await open({ Authorization: "Bearer not-a-token" });
        const refused = await headerLoses.callTool({ name: "typesys_query", arguments: { type: "fleet.Vehicle", authToken: "dispatcher-token" } });
        expect(refused.isError).toBe(true);
        await headerLoses.close();

        // No header at all: the in-band token is the fallback, as on stdio.
        const fallback = await open();
        const viaInBand = await fallback.callTool({ name: "typesys_query", arguments: { type: "fleet.Vehicle", authToken: "dispatcher-token" } });
        expect(viaInBand.isError).not.toBe(true);
        await fallback.close();
      } finally {
        await running.close();
      }
    });

    it("shares one backend across requests: decisions made on separate connections land in the one audit log", async () => {
      const backend = await fleetBackend();
      const { running, open } = await serve(backend);
      try {
        for (const token of ["dispatcher-token", "nobody"]) {
          const client = await open({ Authorization: `Bearer ${token}` });
          await client.callTool({ name: "typesys_query", arguments: { type: "fleet.Vehicle" } });
          await client.close();
        }
        const subjects = (await backend.registry.listAuditEvents({ limit: 1000 })).items.map((e) => e.subjectId);
        expect(subjects).toContain("dana");
        expect(subjects).toContain("anonymous");
      } finally {
        await running.close();
      }
    });

    it("readiness asks the registry it was given", async () => {
      const healthy = await serve(await fleetBackend());
      try {
        expect((await fetch(`http://localhost:${healthy.running.port}/readyz`)).status).toBe(200);
      } finally {
        await healthy.running.close();
      }

      const broken = await fleetBackend();
      broken.registry.listActions = () => Promise.reject(new Error("registry store is down"));
      const down = await serve(broken);
      try {
        const res = await fetch(`http://localhost:${down.running.port}/readyz`);
        expect(res.status).toBe(503);
        expect(await res.json()).toMatchObject({ status: "not_ready" });
        expect((await fetch(`http://localhost:${down.running.port}/healthz`)).status).toBe(200); // liveness asks nothing of it
      } finally {
        await down.running.close();
      }
    });
  });

  describe("the package depends on no domain", () => {
    const pkgDir = fileURLToPath(new URL("..", import.meta.url));
    const pkg = JSON.parse(readFileSync(`${pkgDir}package.json`, "utf8")) as Record<string, Record<string, string> | undefined>;

    it("no production dependency, peer dependency or binary names a domain or the demo", () => {
      for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
        expect(Object.keys(pkg[field] ?? {}).filter((name) => /^@typesys\/(domain-|demo-)/.test(name))).toEqual([]);
      }
      expect(pkg.bin).toBeUndefined();
    });

    it("no source file imports a domain, or carries a piece of one", () => {
      const srcDir = `${pkgDir}src/`;
      const files = readdirSync(srcDir).filter((f) => f.endsWith(".ts"));
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        // Code only: a comment may point at where the demo's pieces live; nothing may import or embed them.
        const source = readFileSync(`${srcDir}${file}`, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");
        expect([file, /@typesys\/domain-/.test(source)]).toEqual([file, false]);
        expect([file, /airforce|Aircraft|AF86-\d/i.test(source)]).toEqual([file, false]);
      }
    });
  });
});
