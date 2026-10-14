import type { Server } from "node:http";
import { request } from "node:http";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Identity } from "@typesys/core";
import { buildAirforceTestbed, demoIdentities, groundForRepair, type AirforceTestbed } from "@typesys/domain-airforce";
import { WorkflowEngine, scriptedModel } from "@typesys/workflow";
import { createApiApp } from "../src/index.js";

/*
 * Adversarial probes of the governed REST API (ADR-0058). Each `it` asserts
 * the secure / correct behavior; a failing test is a confirmed finding.
 */

const TOKENS: Record<string, Identity> = {
  "token-maintainer": demoIdentities.maintainer,
  "token-lead": demoIdentities.lead,
  "token-viewer": demoIdentities.viewer
};
class TokenRejected extends Error {}
const resolve = async (t: string | null | undefined): Promise<Identity> => {
  if (!t) return demoIdentities.anonymous;
  if (t === "expired") throw new TokenRejected('"exp" claim timestamp check failed'); // what jose throws for an expired JWT with failOpenToAnonymous: false
  return Object.hasOwn(TOKENS, t) ? TOKENS[t]! : demoIdentities.anonymous;
};

let testbed: AirforceTestbed;
let server: Server;
let port: number;
const errors: unknown[] = [];

beforeAll(async () => {
  testbed = await buildAirforceTestbed({ mockRestLatencyMs: 0 });
  const workflows = await WorkflowEngine.create({ host: testbed, model: scriptedModel({ triage: { eventId: "EVT-9002", priority: "urgent", rationale: "Avionics fault." } }) });
  workflows.register(groundForRepair);
  const app = createApiApp({ backend: testbed, identityResolver: resolve, workflows, onError: (err) => errors.push(err) });
  await new Promise<void>((r) => (server = app.listen(0, "127.0.0.1", () => r())));
  port = (server.address() as { port: number }).port;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const raw = (method: string, path: string, headers: Record<string, string>, body?: string) =>
  new Promise<{ status: number; type: string | undefined; text: string }>((r, j) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (text += c));
      res.on("end", () => r({ status: res.statusCode!, type: res.headers["content-type"], text }));
    });
    req.on("error", j);
    if (body !== undefined) req.write(body);
    req.end();
  });

describe("pressure: malformed and oversized request bodies", () => {
  it("a body that is not JSON is a 400 problem, with no stack trace or file paths", async () => {
    const res = await raw("POST", "/api/query", { host: `127.0.0.1:${port}`, "content-type": "application/json", authorization: "Bearer token-maintainer" }, '{"type":');
    expect(res.text).not.toMatch(/at .*node_modules|body-parser|SyntaxError|\/home\//);
    expect(res.type).toMatch(/application\/problem\+json/);
    expect(res.status).toBe(400);
  });

  it("a body over the limit is a 413 problem, with no stack trace", async () => {
    const big = JSON.stringify({ type: "airforce.Aircraft", search: { text: "x".repeat(300 * 1024) } });
    const res = await raw("POST", "/api/query", { host: `127.0.0.1:${port}`, "content-type": "application/json" }, big);
    expect(res.status).toBe(413);
    expect(res.text).not.toMatch(/at .*node_modules|raw-body|PayloadTooLargeError|\/home\//);
    expect(res.type).toMatch(/application\/problem\+json/);
  });

  it("an unknown route under /api answers a problem, not an HTML page", async () => {
    const res = await raw("GET", "/api/nope", { host: `127.0.0.1:${port}` });
    expect(res.status).toBe(404);
    expect(res.type).toMatch(/application\/problem\+json/);
  });
});

describe("pressure: authentication", () => {
  it("a token the resolver rejects (expired / bad signature) is a 401, not a 500 internal error", async () => {
    const before = errors.length;
    const res = await raw("GET", "/api/me", { host: `127.0.0.1:${port}`, authorization: "Bearer expired" });
    expect({ status: res.status, loggedAsServerError: errors.length > before }).toEqual({ status: 401, loggedAsServerError: false });
  });

  it("two Authorization headers never yield the second (privileged) identity", async () => {
    const { connect } = await import("node:net");
    const text = await new Promise<string>((r) => {
      let out = "";
      const sock = connect(port, "127.0.0.1", () =>
        sock.write(`GET /api/me HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer token-viewer\r\nAuthorization: Bearer token-maintainer\r\nConnection: close\r\n\r\n`)
      );
      sock.on("data", (d) => (out += d.toString()));
      sock.on("end", () => r(out));
    });
    expect(text).not.toContain("user-maintainer-1");
  });

  it("a token in the query string is never used", async () => {
    const res = await raw("GET", "/api/me?access_token=token-maintainer", { host: `127.0.0.1:${port}` });
    expect(JSON.parse(res.text)).toMatchObject({ subjectId: "anonymous" });
  });

  it("header scheme case and odd spacing never grant a different identity", async () => {
    for (const h of ["bearer token-maintainer", "BEARER token-maintainer"]) {
      expect(JSON.parse((await raw("GET", "/api/me", { host: `127.0.0.1:${port}`, authorization: h })).text)).toMatchObject({ subjectId: "user-maintainer-1" });
    }
    for (const h of ["Basic token-maintainer", "Bearer", "Bearer  token-maintainer", "Bearertoken-maintainer"]) {
      expect(JSON.parse((await raw("GET", "/api/me", { host: `127.0.0.1:${port}`, authorization: h })).text)).toMatchObject({ subjectId: "anonymous" });
    }
  });
});

describe("pressure: Host / Origin guard", () => {
  const status = async (headers: Record<string, string>) => (await raw("GET", "/api/me", headers)).status;
  it("refuses rebinding-style Host values", async () => {
    for (const host of ["evil.example", "localhost.", "localhost.evil.example", "127.0.0.1.nip.io", "localhost@evil.example", "[::ffff:7f00:1]", "0.0.0.0"]) {
      expect([host, await status({ host })]).toEqual([host, 403]);
    }
  });
  it("refuses a request with no Host header at all (HTTP/1.0)", async () => {
    const { connect } = await import("node:net");
    const text = await new Promise<string>((r) => {
      let out = "";
      const sock = connect(port, "127.0.0.1", () => sock.write("GET /api/me HTTP/1.0\r\n\r\n"));
      sock.on("data", (d) => (out += d.toString()));
      sock.on("end", () => r(out));
    });
    expect(text.split("\r\n")[0]).toMatch(/ 403 /);
  });
  it("refuses a Host header that is not a valid host[:port] (userinfo, path) rather than parsing it as a URL", async () => {
    for (const host of ["evil.example@localhost", "localhost/evil", "evil.example:80@127.0.0.1"]) {
      expect([host, await status({ host })]).toEqual([host, 403]);
    }
  });
  it("refuses a foreign, opaque or null Origin, on reads and writes", async () => {
    for (const origin of ["null", "https://evil.example", "file://", "chrome-extension://abc", "http://localhost.evil.example"]) {
      expect([origin, await status({ host: "localhost", origin })]).toEqual([origin, 403]);
      const post = await raw("POST", "/api/query", { host: "localhost", origin, "content-type": "text/plain" }, "{}");
      expect([origin, post.status]).toEqual([origin, 403]);
    }
  });
});

describe("pressure: workflow runs", () => {
  it("an anonymous caller cannot read the status of someone else's run (initiator, steps, errors)", async () => {
    const started = await raw(
      "POST",
      "/api/workflows/airforce.GroundForRepair/runs",
      { host: `127.0.0.1:${port}`, "content-type": "application/json", authorization: "Bearer token-maintainer" },
      JSON.stringify({ input: { aircraftId: "AF86-0147", assignTo: "SSgt Rivera" } })
    );
    const runId = String((JSON.parse(started.text) as { runId: string }).runId);
    const res = await raw("GET", `/api/workflow-runs/${runId}`, { host: `127.0.0.1:${port}` });
    expect(res.text).not.toContain("user-maintainer-1");
    expect(res.status).toBe(403);
  });

  it("an unknown run id is a 404 not-found, not a 409 conflict", async () => {
    const res = await raw("GET", "/api/workflow-runs/does-not-exist", { host: `127.0.0.1:${port}`, authorization: "Bearer token-lead" });
    expect({ status: res.status, code: (JSON.parse(res.text) as { code: string }).code }).toEqual({ status: 404, code: "not-found" });
  });

  it("listing approvals as an anonymous caller writes no deny audit events (audit flooding)", async () => {
    const count = async () => (await testbed.registry.listAuditEvents({ limit: 100000 })).items.length;
    // At least one run is waiting on an approval (started above).
    const before = await count();
    for (let i = 0; i < 5; i++) await raw("GET", "/api/workflow-approvals", { host: `127.0.0.1:${port}` });
    const after = await count();
    expect(after - before).toBe(0);
  });
});

describe("pressure: prototype keys in paths and bodies", () => {
  it("never answers 500 for prototype-named path segments", async () => {
    const paths = [
      "/api/objects/constructor/x",
      "/api/objects/__proto__/x",
      "/api/objects/airforce.Aircraft/AF86-0147/related/constructor",
      "/api/objects/airforce.Aircraft/AF86-0147/related/__proto__",
      "/api/objects/airforce.Aircraft/AF86-0147/provenance/constructor",
      "/api/objects/airforce.Aircraft/AF86-0147/provenance/__proto__",
      "/api/objects/airforce.Aircraft/AF86-0147/provenance/toString",
      "/api/types/constructor/actions",
      "/api/types/toString/actions"
    ];
    const bad: unknown[] = [];
    for (const p of paths) {
      const res = await raw("GET", p, { host: `127.0.0.1:${port}`, authorization: "Bearer token-maintainer" });
      if (res.status >= 500) bad.push([p, res.status]);
    }
    for (const a of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      for (const verb of ["preview", "invoke"]) {
        const res = await raw("POST", `/api/actions/${a}/${verb}`, { host: `127.0.0.1:${port}`, "content-type": "application/json", authorization: "Bearer token-maintainer" }, "{}");
        if (res.status >= 500) bad.push([a, verb, res.status]);
      }
      const res = await raw("POST", `/api/workflows/${a}/runs`, { host: `127.0.0.1:${port}`, "content-type": "application/json", authorization: "Bearer token-maintainer" }, '{"input":{}}');
      if (res.status >= 500) bad.push(["workflow", a, res.status]);
    }
    expect(bad).toEqual([]);
  });

  it("a __proto__ key in a query body pollutes nothing and is not a 500", async () => {
    const bodies = [
      '{"type":"airforce.Aircraft","__proto__":{"polluted":"yes"}}',
      '{"type":"airforce.Aircraft","filter":{"property":"__proto__","operator":"eq","value":1}}',
      '{"type":"airforce.Aircraft","filter":{"property":"constructor","operator":"eq","value":1}}',
      '{"type":"airforce.Aircraft","select":["__proto__","constructor"]}',
      '{"type":"airforce.Aircraft","sort":[{"property":"constructor"}]}',
      '{"type":"airforce.Aircraft","include":[{"relationship":"constructor"}]}'
    ];
    const bad: unknown[] = [];
    for (const b of bodies) {
      const res = await raw("POST", "/api/query", { host: `127.0.0.1:${port}`, "content-type": "application/json", authorization: "Bearer token-maintainer" }, b);
      if (res.status >= 500) bad.push([b, res.status]);
    }
    for (const b of ['{"type":"airforce.Aircraft","groupBy":["constructor"],"metrics":[{"fn":"count"}]}']) {
      const res = await raw("POST", "/api/aggregate", { host: `127.0.0.1:${port}`, "content-type": "application/json", authorization: "Bearer token-maintainer" }, b);
      if (res.status >= 500) bad.push([b, res.status]);
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(bad).toEqual([]);
  });
});

describe("pressure: existence oracle", () => {
  it("an anonymous caller cannot tell an existing object from a missing one", async () => {
    const real = await raw("GET", "/api/objects/airforce.Aircraft/AF86-0147", { host: `127.0.0.1:${port}` });
    const fake = await raw("GET", "/api/objects/airforce.Aircraft/AF00-0000", { host: `127.0.0.1:${port}` });
    expect({ status: real.status, code: (JSON.parse(real.text) as { code: string }).code }).toEqual({
      status: fake.status,
      code: (JSON.parse(fake.text) as { code: string }).code
    });
  });
});

describe("pressure: the real OIDC resolver behind the API", () => {
  it("an expired JWT, with failOpenToAnonymous: false, is a 401 problem rather than a 500 logged as a server fault", async () => {
    const { SignJWT, generateKeyPair, exportJWK, createLocalJWKSet } = await import("jose");
    const { createOidcIdentityResolver } = await import("@typesys/auth-oidc");
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
    const resolver = createOidcIdentityResolver({ issuer: "https://idp.example", jwks: createLocalJWKSet({ keys: [jwk] }), failOpenToAnonymous: false });
    const expired = await new SignJWT({ roles: ["maintainer"] })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer("https://idp.example")
      .setSubject("someone")
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(privateKey);
    const logged: unknown[] = [];
    const app = createApiApp({ backend: testbed, identityResolver: resolver, onError: (e) => logged.push(e) });
    const s = await new Promise<Server>((r) => {
      const srv = app.listen(0, "127.0.0.1", () => r(srv));
    });
    try {
      const p = (s.address() as { port: number }).port;
      const res = await fetch(`http://127.0.0.1:${p}/api/me`, { headers: { authorization: `Bearer ${expired}` } });
      const body = (await res.json()) as { code: string };
      expect({ status: res.status, code: body.code, logged: logged.length, wwwAuthenticate: res.headers.get("www-authenticate") !== null }).toEqual({
        status: 401,
        code: "unauthorized",
        logged: 0,
        wwwAuthenticate: true
      });
    } finally {
      await new Promise<void>((r) => s.close(() => r()));
    }
  });
});

describe("pressure: the API's contract follows the runtime's configured limits", () => {
  it("/query/validate and /openapi.json report the runtime's maxLimit, as the MCP server does", async () => {
    const small = await buildAirforceTestbed({ mockRestLatencyMs: 0, runtimeOptions: { queryLimits: { maxLimit: 10, defaultLimit: 10 } } });
    const app = createApiApp({ backend: small, identityResolver: resolve });
    const s = await new Promise<Server>((r) => {
      const srv = app.listen(0, "127.0.0.1", () => r(srv));
    });
    try {
      const b = `http://127.0.0.1:${(s.address() as { port: number }).port}/api`;
      const ran = await fetch(`${b}/query`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer token-maintainer" }, body: JSON.stringify({ type: "airforce.Aircraft", limit: 50 }) });
      expect(ran.status).toBe(400); // the runtime refuses limit 50
      const checked = (await (
        await fetch(`${b}/query/validate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: { type: "airforce.Aircraft", limit: 50 } }) })
      ).json()) as { diagnostics: { severity: string }[] };
      const doc = (await (await fetch(`${b}/openapi.json`)).json()) as { components: { schemas: { SemanticQuery: { properties: { limit: { maximum: number } } } } } };
      expect({ validateFindsError: checked.diagnostics.some((d) => d.severity === "error"), openApiMax: doc.components.schemas.SemanticQuery.properties.limit.maximum }).toEqual({
        validateFindsError: true,
        openApiMax: 10
      });
    } finally {
      await new Promise<void>((r) => s.close(() => r()));
    }
  });
});
