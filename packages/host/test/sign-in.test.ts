import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { airforceDeployment } from "@typesys/demo-web/deployments";
import { validateDeployment, type Deployment } from "../src/deployment.js";
import { serve, type Serving } from "../src/serve.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const packsDir = path.join(root, "packs");

/** A small OpenID Connect provider: a discovery document, a key set, and tokens minted on request. */
async function provider() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  let up = true;
  let discoveryHits = 0;
  const server = http.createServer((req, res) => {
    if (!up) {
      res.statusCode = 503;
      res.end();
      return;
    }
    if (req.url === "/.well-known/openid-configuration") {
      discoveryHits++;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          issuer,
          jwks_uri: `${issuer}/keys`,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
          code_challenge_methods_supported: ["S256"]
        })
      );
    } else if (req.url === "/keys") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ keys: [jwk] }));
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const issuer = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const token = (claims: Record<string, unknown>, opts: { audience?: string; issuer?: string; expired?: boolean } = {}) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(opts.issuer ?? issuer)
      .setSubject(String(claims.sub ?? "someone"))
      .setAudience(opts.audience ?? "typesys-airforce")
      .setIssuedAt()
      .setExpirationTime(opts.expired ? "-1m" : "10m")
      .sign(privateKey);
  return {
    issuer,
    token,
    discoveryHits: () => discoveryHits,
    setUp: (v: boolean) => {
      up = v;
    },
    close: () => new Promise<void>((r) => server.close(() => r()))
  };
}

type Provider = Awaited<ReturnType<typeof provider>>;

describe("signing in to a deployment (ADR-0116)", () => {
  let idp: Provider;
  let dir: string;
  let serving: Serving;
  let base: string;

  const deployment = (identity: Record<string, unknown>): Deployment => ({ ...airforceDeployment, identity } as unknown as Deployment);

  beforeAll(async () => {
    idp = await provider();
    dir = mkdtempSync(path.join(tmpdir(), "typesys-signin-"));
    const file = path.join(dir, "airforce.deployment.json");
    writeFileSync(
      file,
      JSON.stringify(
        deployment({
          kind: "oidc",
          issuer: idp.issuer,
          audience: "typesys-airforce",
          rolesClaim: "groups",
          roleMap: { "Fleet Maintainers": ["maintainer"], "Fleet Viewers": ["viewer"] },
          scopes: ["api://typesys/read"]
        })
      )
    );
    serving = await serve({ file, port: 0, packsDir });
    base = `http://localhost:${serving.port}`;
  });

  afterAll(async () => {
    await serving?.close();
    await idp?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const mcp = (headers: Record<string, string> = {}) =>
    fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } })
    });

  it("serves Protected Resource Metadata naming the provider, at both well-known paths", async () => {
    for (const p of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const res = await fetch(`${base}${p}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        resource: base,
        authorization_servers: [idp.issuer],
        bearer_methods_supported: ["header"],
        scopes_supported: ["api://typesys/read"],
        resource_name: "airforce"
      });
      // Named from this request's Host: never kept by a shared cache for another.
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("answers MCP without a token 401, with a challenge an MCP client follows to sign in", async () => {
    const res = await mcp();
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${base}/.well-known/oauth-protected-resource", scope="api://typesys/read"`);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain("sign in");
  });

  it("is signed in to by the MCP SDK's own client: it finds the provider and asks it for a token for this server", async () => {
    let redirected: URL | undefined;
    const provider: OAuthClientProvider = {
      redirectUrl: "http://127.0.0.1:9/callback",
      clientMetadata: { redirect_uris: ["http://127.0.0.1:9/callback"], client_name: "test" },
      clientInformation: () => ({ client_id: "claude-test" }),
      tokens: () => undefined,
      saveTokens: () => undefined,
      redirectToAuthorization: (url) => {
        redirected = url;
      },
      saveCodeVerifier: () => undefined,
      codeVerifier: () => "v"
    };
    expect(await auth(provider, { serverUrl: `${base}/mcp` })).toBe("REDIRECT");
    expect(redirected?.origin + redirected!.pathname).toBe(`${idp.issuer}/authorize`);
    // RFC 8707: the token is asked for this server, which is what its audience is checked against.
    expect(redirected?.searchParams.get("resource")).toBe(`${base}/`);
    expect(redirected?.searchParams.get("scope")).toBe("api://typesys/read");
    expect(redirected?.searchParams.get("client_id")).toBe("claude-test");
  });

  it("answers the API without a token 401 with the same challenge", async () => {
    const res = await fetch(`${base}/api/objects/airforce.Aircraft/AF86-0147`);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(`resource_metadata="${base}/.well-known/oauth-protected-resource"`);
  });

  it("serves a signed-in caller as the roles the provider's groups map to", async () => {
    const token = await idp.token({ sub: "alice", groups: ["Fleet Viewers", "Cafeteria"] });
    const me = (await (await fetch(`${base}/api/me`, { headers: { authorization: `Bearer ${token}` } })).json()) as { subjectId: string; roles: string[] };
    expect(me).toEqual({ subjectId: "alice", roles: ["viewer"] });
    const aircraft = (await (await fetch(`${base}/api/objects/airforce.Aircraft/AF86-0147`, { headers: { authorization: `Bearer ${token}` } })).json()) as { values: Record<string, unknown> };
    expect(aircraft.values.tailNumber).toBe("AF86-0147");
    expect(aircraft.values).not.toHaveProperty("maintenanceStatus");
    const hits = idp.discoveryHits();
    expect((await mcp({ authorization: `Bearer ${token}` })).status).toBe(200);
    expect((await fetch(`${base}/api/me`, { headers: { authorization: `Bearer ${await idp.token({ sub: "bob", groups: ["Fleet Maintainers"] })}` } })).status).toBe(200);
    // Discovery is read once and kept: later tokens are checked without asking for it again.
    expect(idp.discoveryHits()).toBe(hits);
  });

  it("refuses a token issued for another application, an expired one and another issuer's, 401 invalid_token", async () => {
    for (const token of [
      await idp.token({ sub: "mallory", groups: ["Fleet Maintainers"] }, { audience: "payroll" }),
      await idp.token({ sub: "alice", groups: ["Fleet Maintainers"] }, { expired: true }),
      await idp.token({ sub: "alice", groups: ["Fleet Maintainers"] }, { issuer: "https://elsewhere.example" })
    ]) {
      const api = await fetch(`${base}/api/me`, { headers: { authorization: `Bearer ${token}` } });
      expect(api.status).toBe(401);
      expect(api.headers.get("www-authenticate")).toContain('error="invalid_token"');
      const res = await mcp({ authorization: `Bearer ${token}` });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain('error="invalid_token"');
    }
  });

  it("answers 503, not 401, while the provider cannot be reached for a key it has not fetched", async () => {
    // A fresh server, so its keys have not been fetched yet.
    const file = path.join(dir, "down.deployment.json");
    writeFileSync(file, JSON.stringify(deployment({ kind: "oidc", issuer: idp.issuer, audience: "typesys-airforce", rolesClaim: "groups" })));
    const s = await serve({ file, port: 0, packsDir });
    try {
      idp.setUp(false);
      const token = await idp.token({ sub: "alice", groups: ["viewer"] });
      const api = await fetch(`http://localhost:${s.port}/api/me`, { headers: { authorization: `Bearer ${token}` } });
      expect(api.status).toBe(503);
      expect(((await api.json()) as { code: string }).code).toBe("unavailable");
      const res = await fetch(`http://localhost:${s.port}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } })
      });
      expect(res.status).toBe(503);
      // Up again: discovery is tried again rather than its failure remembered.
      idp.setUp(true);
      expect((await fetch(`http://localhost:${s.port}/api/me`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
    } finally {
      idp.setUp(true);
      await s.close();
    }
  });

  it("serves no-token callers as anonymous only when the deployment allows it", async () => {
    const file = path.join(dir, "anon.deployment.json");
    writeFileSync(file, JSON.stringify(deployment({ kind: "oidc", issuer: idp.issuer, audience: "typesys-airforce", allowAnonymous: true, resource: "https://typesys.example.com" })));
    const s = await serve({ file, port: 0, packsDir });
    try {
      const me = await fetch(`http://localhost:${s.port}/api/me`);
      expect(me.status).toBe(200);
      expect(((await me.json()) as { subjectId: string }).subjectId).toBe("anonymous");
      // A configured resource is named as given, and may be cached.
      const meta = await fetch(`http://localhost:${s.port}/.well-known/oauth-protected-resource`);
      expect(((await meta.json()) as { resource: string }).resource).toBe("https://typesys.example.com");
      expect(meta.headers.get("cache-control")).toBe("public, max-age=300");
      // A bad token is still refused, not served as anonymous.
      expect((await fetch(`http://localhost:${s.port}/api/me`, { headers: { authorization: "Bearer not-a-jwt" } })).status).toBe(401);
    } finally {
      await s.close();
    }
  });

  it("answers the metadata only to an allowed Host, as /mcp is", async () => {
    const res = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: serving.port, path: "/.well-known/oauth-protected-resource", headers: { host: "evil.example" } }, (r) => {
        r.resume();
        resolve(r.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
    expect(res).toBe(403);
  });
});

describe("a deployment's identity, validated (ADR-0116)", () => {
  const shared = (identity: Record<string, unknown>) => validateDeployment({ ...airforceDeployment, demo: false, identity } as unknown as Deployment).join("\n");

  it("requires an audience outside a demo", () => {
    expect(shared({ kind: "oidc", issuer: "https://idp.example" })).toContain("identity.audience: required outside a demo");
    expect(shared({ kind: "oidc", issuer: "https://idp.example", audience: "typesys" })).not.toContain("identity.audience");
    expect(validateDeployment({ ...airforceDeployment, identity: { kind: "oidc", issuer: "https://idp.example" } } as unknown as Deployment).join("\n")).not.toContain("identity.audience");
  });

  it("checks the resource, scopes, roleMap and allowAnonymous", () => {
    const out = shared({ kind: "oidc", issuer: "https://idp.example", audience: "a", resource: "https://typesys.example.com/mcp", scopes: [""], roleMap: { g: "maintainer" }, allowAnonymous: "yes" });
    expect(out).toContain("identity.resource: must be the server's origin");
    expect(out).toContain("identity.scopes: must be a list of scope names");
    expect(out).toContain("identity.roleMap.g: must be a list of roles");
    expect(out).toContain("identity.allowAnonymous: must be true or false");
    expect(shared({ kind: "oidc", issuer: "https://idp.example", audience: "a", resource: "https://typesys.example.com", scopes: ["read"], roleMap: { g: ["maintainer"] }, allowAnonymous: false })).not.toContain("identity.");
  });
});
