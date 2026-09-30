import { describe, it, expect } from "vitest";
import { demoIdentities, resolveDemoIdentity } from "../src/setup.js";

/** The demo's static token map (ADR-0050): two tokens grant a role; nothing else does. */
describe("resolveDemoIdentity", () => {
  it("maps the two demo tokens to their identities", async () => {
    expect(await resolveDemoIdentity("demo-maintainer-token")).toBe(demoIdentities.maintainer);
    expect(await resolveDemoIdentity("demo-viewer-token")).toBe(demoIdentities.viewer);
  });

  it("everything else — no token, an unknown one, a near miss — is anonymous", async () => {
    for (const token of [undefined, null, "", "nope", "demo-maintainer-token ", "DEMO-MAINTAINER-TOKEN", "demo-admin-token"]) {
      expect(await resolveDemoIdentity(token)).toBe(demoIdentities.anonymous);
    }
  });

  it("attack: a token naming an Object.prototype member is not a token, and never resolves to a function", async () => {
    for (const token of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf", "prototype"]) {
      const identity = await resolveDemoIdentity(token);
      expect(identity).toBe(demoIdentities.anonymous);
      expect(identity.roles).toEqual([]);
    }
  });
});
