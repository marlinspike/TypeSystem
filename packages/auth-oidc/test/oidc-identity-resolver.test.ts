import { describe, it, expect, beforeAll } from "vitest";
import { generateKeyPair, SignJWT, exportJWK, createLocalJWKSet, type JWTVerifyGetKey, type KeyLike } from "jose";
import { createOidcIdentityResolver, anonymousIdentity } from "../src/oidc-identity-resolver.js";

const ISSUER = "https://idp.example.com";
const AUDIENCE = "typesys-demo";

let privateKey: KeyLike;
let localJwks: JWTVerifyGetKey;

async function mintToken(claims: Record<string, unknown>, opts: { issuer?: string; audience?: string; expired?: boolean } = {}): Promise<string> {
  const jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuedAt()
    .setIssuer(opts.issuer ?? ISSUER)
    .setAudience(opts.audience ?? AUDIENCE);
  jwt.setExpirationTime(opts.expired ? "-1h" : "1h");
  return jwt.sign(privateKey);
}

beforeAll(async () => {
  const { publicKey, privateKey: priv } = await generateKeyPair("RS256");
  privateKey = priv;
  const publicJwk = await exportJWK(publicKey);
  // Real cryptographic verification against a real key pair — the same jwtVerify
  // call a remote-JWKS production config hits, with zero network calls (ADR-0018).
  localJwks = createLocalJWKSet({ keys: [{ ...publicJwk, kid: "test-key", alg: "RS256" }] });
});

describe("createOidcIdentityResolver", () => {
  it("resolves anonymous for no token, without attempting verification", async () => {
    const resolver = createOidcIdentityResolver({ issuer: ISSUER, jwks: localJwks });
    expect(await resolver(undefined)).toEqual(anonymousIdentity());
    expect(await resolver(null)).toEqual(anonymousIdentity());
  });

  it("verifies a real signed token and maps sub/roles/scope onto an Identity", async () => {
    const token = await mintToken({ sub: "user-42", roles: ["maintainer", "viewer"], scope: "read write" });
    const resolver = createOidcIdentityResolver({ issuer: ISSUER, audience: AUDIENCE, jwks: localJwks });

    const identity = await resolver(token);
    expect(identity.subjectId).toBe("user-42");
    expect(identity.roles).toEqual(["maintainer", "viewer"]);
    expect(identity.tokenScopes).toEqual(["read", "write"]);
    expect(identity.attributes.sub).toBe("user-42");
  });

  it("reads roles from a nested claim path (rolesClaim)", async () => {
    const token = await mintToken({ sub: "user-1", realm_access: { roles: ["admin"] } });
    const resolver = createOidcIdentityResolver({ issuer: ISSUER, jwks: localJwks, rolesClaim: "realm_access.roles" });

    const identity = await resolver(token);
    expect(identity.roles).toEqual(["admin"]);
  });

  it("fails closed to anonymous on a wrong issuer, by default", async () => {
    const token = await mintToken({ sub: "user-1" }, { issuer: "https://not-the-real-idp.example.com" });
    const resolver = createOidcIdentityResolver({ issuer: ISSUER, jwks: localJwks });

    expect(await resolver(token)).toEqual(anonymousIdentity());
  });

  it("fails closed to anonymous on an expired token, by default", async () => {
    const token = await mintToken({ sub: "user-1" }, { expired: true });
    const resolver = createOidcIdentityResolver({ issuer: ISSUER, jwks: localJwks });

    expect(await resolver(token)).toEqual(anonymousIdentity());
  });

  it("fails closed to anonymous on a wrong audience, by default", async () => {
    const token = await mintToken({ sub: "user-1" }, { audience: "some-other-app" });
    const resolver = createOidcIdentityResolver({ issuer: ISSUER, audience: AUDIENCE, jwks: localJwks });

    expect(await resolver(token)).toEqual(anonymousIdentity());
  });

  it("throws instead of failing open when failOpenToAnonymous is false", async () => {
    const token = await mintToken({ sub: "user-1" }, { expired: true });
    const resolver = createOidcIdentityResolver({ issuer: ISSUER, jwks: localJwks, failOpenToAnonymous: false });

    await expect(resolver(token)).rejects.toThrow();
  });

  it("rejects a token signed by a different key entirely (not just a claims mismatch)", async () => {
    const { privateKey: otherPrivateKey } = await generateKeyPair("RS256");
    const forgedToken = await new SignJWT({ sub: "attacker" })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" }) // claims the same kid, signed with a different key
      .setIssuedAt()
      .setIssuer(ISSUER)
      .setExpirationTime("1h")
      .sign(otherPrivateKey);

    const resolver = createOidcIdentityResolver({ issuer: ISSUER, jwks: localJwks });
    expect(await resolver(forgedToken)).toEqual(anonymousIdentity());
  });
});
