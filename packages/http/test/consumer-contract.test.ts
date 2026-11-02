import type { Server } from "node:http";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ContractUnsatisfiedError } from "@typesys/core";
import { buildAirforceTestbed, demoIdentities, resolveDemoIdentity } from "@typesys/domain-airforce";
import { ApiError, contractHeader, httpCall, runtimeTransport } from "@typesys/sdk";
import { createApiApp } from "../src/index.js";

/** ADR-0103: the REST API serves each request under its consumer's contract, and refuses one outside it with 412. */
let server: Server;
let base: string;
let pinnedServer: Server;
let pinnedBase: string;

const listen = (app: ReturnType<typeof createApiApp>) =>
  new Promise<{ server: Server; base: string }>((resolve) => {
    const s = app.listen(0, () => resolve({ server: s, base: `http://localhost:${(s.address() as { port: number }).port}/api` }));
  });

beforeAll(async () => {
  ({ server, base } = await listen(createApiApp({ backend: await buildAirforceTestbed(), identityResolver: resolveDemoIdentity })));
  ({ server: pinnedServer, base: pinnedBase } = await listen(createApiApp({ backend: await buildAirforceTestbed(), identityResolver: resolveDemoIdentity, contract: { "airforce.Aircraft": "^2.0.0" } })));
});
afterAll(async () => {
  await Promise.all([server, pinnedServer].map((s) => new Promise<void>((r) => s.close(() => r()))));
});

const get = (at: string, header?: string) =>
  fetch(`${at}/objects/airforce.Aircraft/AF86-0147`, { headers: { authorization: "Bearer demo-maintainer-token", ...(header !== undefined ? { "TypeSystem-Contract": header } : {}) } });

describe("consumer contracts over the REST API", () => {
  it("serves a request within its contract, and answers 412 contract-unsatisfied naming the Type and range otherwise", async () => {
    expect((await get(base, "airforce.Aircraft@^1.0.0")).status).toBe(200);
    const res = await get(base, "airforce.Aircraft@^2.0.0, airforce.Component@^1.0.0");
    expect(res.status).toBe(412);
    expect(await res.json()).toMatchObject({ code: "contract-unsatisfied", errors: [{ type: "airforce.Aircraft", range: "^2.0.0" }] });
  });

  it("answers 400 for a header that is not a contract", async () => {
    const res = await get(base, "airforce.Aircraft");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "invalid-input" });
  });

  it("serves under the server's contract when the request sends none", async () => {
    expect((await get(pinnedBase)).status).toBe(412);
    expect((await get(pinnedBase, "airforce.Aircraft@1.x")).status).toBe(200);
  });

  it("reports under a contract whether the model keeps it", async () => {
    const model = (await (await fetch(`${base}/model`, { headers: { authorization: "Bearer demo-maintainer-token", "TypeSystem-Contract": "airforce.Aircraft@^2.0.0" } })).json()) as { contract?: unknown };
    expect(model.contract).toEqual({ satisfied: false, mismatches: [{ type: "airforce.Aircraft", range: "^2.0.0", version: "1.0.0" }] });
  });

  it("the SDK sends its contract with every call, and surfaces the refusal's code", async () => {
    expect(contractHeader({ "b.B": "1.x", "a.A": "^1.0.0" })).toBe("a.A@^1.0.0, b.B@1.x");
    const call = httpCall({ baseUrl: base, token: "demo-maintainer-token", contract: { "airforce.Aircraft": "^2.0.0" } });
    const err = await call("GET", "/objects/airforce.Aircraft/AF86-0147").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(412);
    expect((err as ApiError).code).toBe("contract-unsatisfied");
    await expect(httpCall({ baseUrl: base, token: "demo-maintainer-token", contract: { "airforce.Aircraft": "^1.0.0" } })("GET", "/objects/airforce.Aircraft/AF86-0147")).resolves.toBeDefined();
  });

  it("an in-process client makes every call under its contract", async () => {
    const { runtime } = await buildAirforceTestbed();
    await expect(runtimeTransport(runtime, demoIdentities.maintainer, { contract: { "airforce.Aircraft": "^2.0.0" } }).getObject("airforce.Aircraft", "AF86-0147", { includeProvenance: false })).rejects.toBeInstanceOf(ContractUnsatisfiedError);
    await expect(runtimeTransport(runtime, demoIdentities.maintainer, { contract: { "airforce.Aircraft": "^1.0.0" } }).getObject("airforce.Aircraft", "AF86-0147", { includeProvenance: false })).resolves.toBeDefined();
  });
});
