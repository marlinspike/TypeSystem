import { describe, it, expect, beforeEach } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Identity, ResolvedObject, SemanticQuery } from "@typesys/core";
import { buildAirforceTestbed, demoIdentities, resolveDemoIdentity, type AirforceModel, type AirforceTestbed } from "@typesys/domain-airforce";
import { createServer } from "@typesys/mcp-server";
import { createClient, mcpTransport, runtimeTransport, RemoteToolError, toRow, type Client } from "../src/index.js";

const TOKENS: Record<"maintainer" | "viewer" | "anonymous", string | undefined> = {
  maintainer: "demo-maintainer-token",
  viewer: "demo-viewer-token",
  anonymous: undefined
};
const CALLERS = ["maintainer", "viewer", "anonymous"] as const;

/** Any built query, whatever its row type. */
interface Built {
  toQuery(): SemanticQuery;
  all(): AsyncIterable<unknown>;
}

/** The same queries, written with the SDK; each must mean exactly the SemanticQuery it builds. */
const QUERIES: ((c: Client<AirforceModel>) => Built)[] = [
  (c) => c.from("airforce.Aircraft"),
  (c) => c.from("airforce.Aircraft").where((a) => a.needsAttention.eq(true)),
  (c) => c.from("airforce.Aircraft").where({ model: "F-16C" }).select("tailNumber", "readinessStatus").orderBy("tailNumber", "desc"),
  (c) => c.from("airforce.Aircraft").include("components", (q) => q.select("partNumber", "condition").where((x) => x.condition.in(["fair", "poor"]))),
  (c) => c.from("airforce.Aircraft").include("maintenance", (m) => m.include("workOrder")).withProvenance(),
  (c) => c.from("airforce.Component").where((x) => x.condition.ne("good").or(x.partNumber.icontains("f100"))).limit(1)
];

async function rawRows(testbed: AirforceTestbed, q: SemanticQuery, identity: Identity): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  let cursor: string | undefined;
  do {
    const page = await testbed.runtime.query(cursor ? { ...q, cursor } : q, identity);
    rows.push(...page.items.map((o: ResolvedObject) => toRow(o, q.include, q.includeProvenance === true)));
    cursor = page.nextCursor;
  } while (cursor);
  return rows;
}

/** Provenance carries the time each value was read, which differs between two reads of the same value. */
function stable<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (key, v: unknown) => (key === "retrievedAt" ? "<time>" : v))) as T;
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe("@typesys/sdk client (ADR-0055)", () => {
  let testbed: AirforceTestbed;
  let mcp: McpClient;

  beforeEach(async () => {
    testbed = await buildAirforceTestbed();
    const { server } = createServer(testbed, resolveDemoIdentity);
    mcp = new McpClient({ name: "sdk-test", version: "0.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([mcp.connect(a), server.connect(b)]);
    await mcp.listTools();
  });

  const inProcess = (who: (typeof CALLERS)[number]) => createClient<AirforceModel>(runtimeTransport(testbed.runtime, demoIdentities[who]));
  const overMcp = (who: (typeof CALLERS)[number]) => createClient<AirforceModel>(mcpTransport(mcp, { authToken: TOKENS[who] }));

  it("builds the SemanticQuery a caller would write by hand", () => {
    const q = inProcess("viewer")
      .from("airforce.Aircraft")
      .where((a) => a.needsAttention.eq(true))
      .where({ model: "F-16C" })
      .select("tailNumber", "needsAttention")
      .orderBy("tailNumber")
      .limit(5)
      .include("components", (c) => c.select("partNumber").orderBy("partNumber", "desc").limit(2))
      .toQuery();
    expect(q).toEqual({
      type: "airforce.Aircraft",
      filter: { and: [{ property: "needsAttention", operator: "eq", value: true }, { property: "model", operator: "eq", value: "F-16C" }] },
      select: ["tailNumber", "needsAttention"],
      sort: [{ property: "tailNumber", direction: "asc" }],
      limit: 5,
      include: [{ relationship: "components", select: ["partNumber"], sort: [{ property: "partNumber", direction: "desc" }], limit: 2 }]
    });
  });

  it("returns what the runtime returns, for every caller, in process and over MCP", async () => {
    // Rows, or the refusal: a denied caller is refused alike on every path, MCP carrying the runtime's message.
    const outcome = async (run: () => Promise<unknown>) => {
      try {
        return { rows: stable(await run()) };
      } catch (err) {
        return { refused: (err as Error).message };
      }
    };
    let refusals = 0;
    for (const who of CALLERS) {
      for (const build of QUERIES) {
        const query = build(inProcess(who));
        const label = `${who} ${JSON.stringify(query.toQuery())}`;
        const expected = await outcome(() => rawRows(testbed, query.toQuery(), demoIdentities[who]));
        if ("refused" in expected) refusals++;
        expect(await outcome(() => collect(query.all())), label).toEqual(expected);
        expect(await outcome(() => collect(build(overMcp(who)).all())), `${label} over MCP`).toEqual(expected);
      }
    }
    expect(refusals).toBe(QUERIES.length); // anonymous, on every query
  });

  it("filters on a computed property under policy: the viewer may not, and gets nothing (ADR-0052, ADR-0054)", async () => {
    const fmc = (c: Client<AirforceModel>) => c.from("airforce.Aircraft").where((a) => a.readinessStatus.eq("FMC")).select("tailNumber");
    expect(await collect(fmc(inProcess("maintainer")).all())).toEqual([{ $id: "AF86-0212", $type: "airforce.Aircraft", tailNumber: "AF86-0212" }]);
    expect(await collect(fmc(inProcess("viewer")).all())).toEqual([]);
    expect(await collect(fmc(overMcp("viewer")).all())).toEqual([]);
  });

  it("reads one object, its relationships, and provenance alike on both transports", async () => {
    for (const who of ["maintainer", "viewer"] as const) {
      const [local, remote] = [inProcess(who), overMcp(who)];
      expect(await remote.get("airforce.Aircraft", "AF86-0147")).toEqual(await local.get("airforce.Aircraft", "AF86-0147"));
      expect(stable(await remote.get("airforce.Aircraft", "AF86-0147", { provenance: true }))).toEqual(stable(await local.get("airforce.Aircraft", "AF86-0147", { provenance: true })));
      expect(await remote.related("airforce.Aircraft", "AF86-0147", "components")).toEqual(await local.related("airforce.Aircraft", "AF86-0147", "components"));
      expect(stable(await remote.provenance("airforce.Aircraft", "AF86-0147", "needsAttention"))).toEqual(stable(await local.provenance("airforce.Aircraft", "AF86-0147", "needsAttention")));
    }
    const viewer = await inProcess("viewer").get("airforce.Aircraft", "AF86-0147");
    expect(viewer).toMatchObject({ $id: "AF86-0147", $type: "airforce.Aircraft", needsAttention: true });
    expect(viewer).not.toHaveProperty("maintenanceStatus");
    expect(viewer).not.toHaveProperty("readinessStatus");
  });

  it("pages with all() until the runtime has no next page, and converts included objects to rows", async () => {
    const rows = await collect(inProcess("maintainer").from("airforce.Aircraft").limit(1).include("components", (c) => c.select("partNumber")).all());
    expect(rows.map((r) => r.$id)).toEqual(["AF86-0147", "AF86-0212"]);
    const components = rows.flatMap((r) => r.components);
    expect(components.length).toBeGreaterThan(0);
    for (const c of components) expect(Object.keys(c).sort()).toEqual(["$id", "$type", "partNumber"]);
  });

  it("answers alike below the client too: the MCP transport drops the provenance its read always carries", async () => {
    const local = runtimeTransport(testbed.runtime, demoIdentities.viewer);
    const remote = mcpTransport(mcp, { authToken: TOKENS.viewer });
    expect(await remote.getObject("airforce.Aircraft", "AF86-0147", { includeProvenance: false })).toEqual(
      await local.getObject("airforce.Aircraft", "AF86-0147", { includeProvenance: false })
    );
  });

  it("explains a query without running it", async () => {
    const plan = await inProcess("viewer").from("airforce.Aircraft").where((a) => a.needsAttention.eq(true)).explain();
    expect(plan.steps.map((s) => s.op)).toContain("residual-filter");
    expect(await overMcp("viewer").from("airforce.Aircraft").where((a) => a.needsAttention.eq(true)).explain()).toEqual(plan);
  });

  it("first() pages past rows a residual filter removes", async () => {
    const row = await inProcess("maintainer").from("airforce.Aircraft").where((a) => a.readinessStatus.eq("FMC")).first();
    expect(row?.$id).toBe("AF86-0212");
    expect(await inProcess("maintainer").from("airforce.Aircraft").where((a) => a.readinessStatus.eq("NMC")).first()).toBeUndefined();
  });

  it("previews and invokes typed Actions, with the runtime's decision on each transport", async () => {
    for (const client of [inProcess("maintainer"), overMcp("maintainer")]) {
      const created = await client.action("CreateMaintenanceWorkOrder").invoke({ maintenanceEventId: "EVT-9001", assignedTo: "SSgt Rivera" });
      const workOrderId = created.id!;
      const listed = await client.actions("airforce.WorkOrder", workOrderId);
      expect(listed.map((a) => [a.name, a.authorized])).toEqual([["UpdateWorkOrderStatus", true]]);
      const preview = await client.action("UpdateWorkOrderStatus").preview({ workOrderId, status: "closed" });
      expect(preview).toMatchObject({ wouldExecute: true, target: { typeName: "airforce.WorkOrder", objectId: workOrderId } });
      expect(await client.get("airforce.WorkOrder", workOrderId)).toMatchObject({ status: "open" });
      await client.action("UpdateWorkOrderStatus").invoke({ workOrderId, status: "closed" });
      expect(await client.get("airforce.WorkOrder", workOrderId)).toMatchObject({ status: "closed" });
    }
    const viewer = overMcp("viewer");
    expect(await viewer.action("UpdateWorkOrderStatus").preview({ workOrderId: "WO-none", status: "closed" })).toMatchObject({ wouldExecute: false });
    await expect(viewer.action("CreateMaintenanceWorkOrder").invoke({ maintenanceEventId: "EVT-9001", assignedTo: "x" })).rejects.toBeInstanceOf(RemoteToolError);
  });

  it("carries the runtime's own errors in process", async () => {
    await expect(inProcess("anonymous").get("airforce.Aircraft", "AF86-0147")).rejects.toMatchObject({ name: "AuthorizationError" });
    // An invalid query reaches the runtime unchanged, and the runtime refuses it.
    await expect(inProcess("viewer").from("airforce.Aircraft").limit(100_000).page()).rejects.toMatchObject({ name: "InvalidInputError" });
  });
});
