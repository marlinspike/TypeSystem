import { describe, it, expect } from "vitest";
import { EncryptionConfigError, LocalKeyProvider } from "../src/index.js";

const key = (byte: number) => Buffer.alloc(32, byte).toString("base64");

describe("LocalKeyProvider (ADR-0033)", () => {
  it("serves the active key for writes, any held key by id, and every key active-first for index lookups", async () => {
    const keys = new LocalKeyProvider({ keys: { old: key(1), current: key(2) }, active: "current" });
    expect((await keys.activeKey()).id).toBe("current");
    expect((await keys.keyById("old"))?.material).toEqual(Buffer.alloc(32, 1));
    expect(await keys.keyById("retired-long-ago")).toBeUndefined();
    expect((await keys.allKeys()).map((k) => k.id)).toEqual(["current", "old"]);
  });

  it("accepts raw bytes and copies them, so later changes to the caller's buffer can't change the key", async () => {
    const bytes = Buffer.alloc(32, 7);
    const keys = new LocalKeyProvider({ keys: { k: bytes }, active: "k" });
    bytes.fill(0);
    expect((await keys.activeKey()).material).toEqual(Buffer.alloc(32, 7));
  });

  it("refuses keys that aren't exactly 32 bytes of base64, ids outside [A-Za-z0-9_-], and a missing active key", () => {
    const refuse = (keyring: ConstructorParameters<typeof LocalKeyProvider>[0]) => () => new LocalKeyProvider(keyring);
    expect(refuse({ keys: { k: Buffer.alloc(16, 1).toString("base64") }, active: "k" })).toThrow(/32 bytes/);
    expect(refuse({ keys: { k: Buffer.alloc(33, 1) }, active: "k" })).toThrow(/32 bytes/);
    expect(refuse({ keys: { k: "not base64!!" }, active: "k" })).toThrow(/base64/);
    expect(refuse({ keys: { "bad.id": key(1) }, active: "bad.id" })).toThrow(/Key id/);
    expect(refuse({ keys: { "": key(1) }, active: "" })).toThrow(EncryptionConfigError);
    expect(refuse({ keys: { k: key(1) }, active: "other" })).toThrow(/active key "other"/);
  });

  it("reads a keyring from the environment, the first key active", async () => {
    const keys = LocalKeyProvider.fromEnv({ TYPESYS_ENCRYPTION_KEYS: ` 2026-09:${key(9)}, 2026-06:${key(6)} ` });
    expect((await keys.activeKey()).id).toBe("2026-09");
    expect((await keys.allKeys()).map((k) => k.id)).toEqual(["2026-09", "2026-06"]);
    expect((await LocalKeyProvider.fromEnv({ KEYS: `a:${key(1)}` }, "KEYS").activeKey()).id).toBe("a");
  });

  it("refuses a missing, malformed, or ambiguous environment keyring", () => {
    expect(() => LocalKeyProvider.fromEnv({})).toThrow(/not set/);
    expect(() => LocalKeyProvider.fromEnv({ TYPESYS_ENCRYPTION_KEYS: key(1) })).toThrow(/id:base64/);
    expect(() => LocalKeyProvider.fromEnv({ TYPESYS_ENCRYPTION_KEYS: `a:${key(1)},a:${key(2)}` })).toThrow(/twice/);
    expect(() => LocalKeyProvider.fromEnv({ TYPESYS_ENCRYPTION_KEYS: "a:short" })).toThrow(EncryptionConfigError);
  });
});
