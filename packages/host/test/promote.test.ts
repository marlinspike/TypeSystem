import { describe, it, expect } from "vitest";
import path from "node:path";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { generateKeyPairSync } from "node:crypto";
import { fileURLToPath } from "node:url";
import { airforceDeployment } from "@typesys/demo-web/deployments";
import { validateDeployment, type Deployment } from "../src/deployment.js";
import { promoteCommand, promoteDeployment, referencesOf, rolesOf, sharedFileFor } from "../src/promote.js";
import { deployCommand } from "../src/cli.js";

const PEM = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** A development deployment as `typesys init` writes one: a demo, fixed tokens, a postgres source. */
const dev = {
  format: "typesys.deployment/1",
  name: "shop",
  demo: true,
  packs: [{ name: "shop", version: "1.0.0" }],
  sources: { "shop-db": { kind: "postgres", system: "shop", url: { $secret: "SHOP_URL" }, types: { "shop.Order": { table: "orders", id: "order_id", columns: { orderId: "order_id" } } } } },
  policies: { "shop.read-order": { role: ["reader"] }, "shop.contact": { anyOf: [{ role: ["steward"] }, { allOf: [{ role: ["support"] }, { attributeMatch: { resource: "region", subject: "region" } }] }] } },
  identity: { kind: "tokens", tokens: { "dev-reader-x": "reader", "dev-steward-y": "steward" } },
  personas: { reader: { subjectId: "reader", roles: ["reader"], attributes: {} }, steward: { subjectId: "steward", roles: ["reader", "steward"], attributes: {} } }
} as unknown as Deployment;

describe("typesys deploy promote (ADR-0118)", () => {
  it("makes a shared deployment: no demo, OIDC with an audience, signed Postgres audit, and a role map of every role the policies use", () => {
    const shared = promoteDeployment(dev, { issuer: "OIDC_ISSUER", audience: "typesys-shop", resource: "https://shop.example.com", rolesClaim: "groups", publicKey: PEM });
    expect(shared.demo).toBeUndefined();
    expect(shared.identity).toEqual({
      kind: "oidc",
      issuer: { $env: "OIDC_ISSUER" },
      audience: "typesys-shop",
      resource: "https://shop.example.com",
      rolesClaim: "groups",
      // M6 (ADR-0124): the steward group grants what the steward persona holds, reader included; reader stays reader alone.
      roleMap: { reader: ["reader"], steward: ["reader", "steward"], support: ["support"] }
    });
    expect(shared.state?.audit).toEqual({ kind: "postgres", url: { $secret: "TYPESYS_STATE_URL" }, ownerUrl: { $secret: "TYPESYS_STATE_OWNER_URL" }, signing: { keyId: "audit-1", key: { $secret: "TYPESYS_AUDIT_SIGNING_KEY" } }, verifyKeys: { "audit-1": PEM } });
    // What was there is kept, so deploy check and deploy test still work as the personas.
    expect(shared.sources).toBe(dev.sources);
    expect(shared.policies).toBe(dev.policies);
    expect(shared.personas).toBe(dev.personas);
    expect(validateDeployment(shared)).toEqual([]);
    expect(rolesOf(dev)).toEqual(["reader", "steward", "support"]);
    // Shared, so not open: anonymous callers learn nothing and refusals name no roles (ADR-0124).
    expect(shared.runtime?.discovery).toBe("authenticated");
    expect(promoteDeployment({ ...dev, runtime: { discovery: "need-to-know" } } as Deployment, { issuer: "x", audience: "a", publicKey: "PEM" }).runtime?.discovery).toBe("need-to-know");
    expect(referencesOf(shared)).toEqual({ secrets: ["SHOP_URL", "TYPESYS_AUDIT_SIGNING_KEY", "TYPESYS_STATE_OWNER_URL", "TYPESYS_STATE_URL"], env: ["OIDC_ISSUER"] });
  });

  it("keeps an audit database already declared, and gives applications a durable journal", () => {
    const withState = { ...airforceDeployment, applications: [{ name: "x", port: "4000" }], state: { audit: { kind: "postgres", url: { $secret: "AUDIT_DB" }, retainDays: 90, verifyKeys: { old: "OLDPEM" } } } } as unknown as Deployment;
    const shared = promoteDeployment(withState, { issuer: "https://idp.example", audience: "a", publicKey: "PEM", keyId: "k2", stateSecret: "STATE" });
    expect(shared.state?.audit).toEqual({ kind: "postgres", url: { $secret: "AUDIT_DB" }, ownerUrl: { $secret: "TYPESYS_STATE_OWNER_URL" }, signing: { keyId: "k2", key: { $secret: "TYPESYS_AUDIT_SIGNING_KEY" } }, verifyKeys: { old: "OLDPEM", k2: "PEM" }, retainDays: 90 });
    expect(shared.state?.workflows).toEqual({ kind: "postgres", url: { $secret: "STATE" }, ownerUrl: { $secret: "TYPESYS_STATE_OWNER_URL" } });
    // The demo's classification is not silently made real: it is reported as still to change.
    expect(validateDeployment(shared).join("\n")).toContain("classification: the demonstration ordering is allowed only in a demo deployment");
  });

  it("writes the deployment and a git-ignored private key, prints the secrets, and never replaces either without --force", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "typesys-promote-"));
    try {
      const file = path.join(dir, "shop.deployment.json");
      writeFileSync(file, JSON.stringify(dev));
      const out: string[] = [];
      const err: string[] = [];
      expect(await promoteCommand([file, "--issuer", "https://login.example.com/", "--audience", "api://shop"], (s) => out.push(s), (s) => err.push(s))).toBe(0);
      const sharedFile = path.join(dir, "shop.shared.deployment.json");
      expect(sharedFileFor(file)).toBe(sharedFile);
      const shared = JSON.parse(readFileSync(sharedFile, "utf8")) as Deployment;
      expect(validateDeployment(shared)).toEqual([]);
      const key = path.join(dir, "secrets", "audit-1.private.pem");
      expect(readFileSync(key, "utf8")).toContain("BEGIN PRIVATE KEY");
      expect(statSync(key).mode & 0o777).toBe(0o600);
      expect(readFileSync(path.join(dir, "secrets", ".gitignore"), "utf8")).toBe("*\n");
      const text = out.join("\n");
      expect(text).toContain("TYPESYS_AUDIT_SIGNING_KEY  (the contents of");
      expect(text).toContain("TYPESYS_STATE_URL");
      expect(text).toContain("Roles its policies use: reader, steward, support.");
      // The private key is never printed or put in the deployment.
      expect(text).not.toContain("BEGIN PRIVATE KEY");
      expect(readFileSync(sharedFile, "utf8")).not.toContain("PRIVATE KEY");

      expect(await promoteCommand([file, "--issuer", "https://login.example.com/", "--audience", "api://shop"], () => undefined, (s) => err.push(s))).toBe(1);
      expect(err.join("\n")).toContain("exists: pass --force");
      expect(await promoteCommand([file, "--issuer", "https://login.example.com/", "--audience", "api://shop", "--force"], () => undefined, () => undefined)).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses what it cannot use", async () => {
    const err: string[] = [];
    const run = (argv: string[]) => promoteCommand(argv, () => undefined, (s) => err.push(s));
    expect(await run(["x.json", "--audience", "a"])).toBe(2);
    expect(await run(["x.json", "--issuer", "login.example.com", "--audience", "a"])).toBe(2);
    expect(err.at(-1)).toContain("give a URL (https://...) or the name of the environment variable");
    expect(await run(["x.json", "--issuer", "OIDC", "--audience", "a", "--state-secret", "postgres://u:p@h/db"])).toBe(2);
    expect(await run(["x.json", "--issuer", "OIDC", "--audience", "a", "--bogus"])).toBe(2);
    expect(await run([path.join(root, "nonexistent.json"), "--issuer", "OIDC", "--audience", "a"])).toBe(1);
    expect(existsSync(path.join(root, "nonexistent.shared.deployment.json"))).toBe(false);
    // Reached through typesys deploy, whose own option parser would refuse --issuer.
    expect(await deployCommand(["promote", "x.json", "--audience", "a"])).toBe(2);
  });
});
