import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, it, expect } from "vitest";
import { digestOf, requirementsOf, type PackArchive } from "@typesys/packs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, "../dist/bin.js");
const PACKS = path.resolve(__dirname, "../../../packs");
const core = path.join(PACKS, "core-1.0.0.typesys-pack.json");
const airforce = path.join(PACKS, "airforce-1.0.0.typesys-pack.json");

async function typesys(...args: string[]): Promise<{ code: number; out: Record<string, unknown> }> {
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [BIN, ...args, "--json"]);
    return { code: 0, out: JSON.parse(stdout) as Record<string, unknown> };
  } catch (err) {
    const { code, stdout } = err as { code: number; stdout: string };
    return { code, out: JSON.parse(stdout) as Record<string, unknown> };
  }
}

/** `typesys pack` (ADR-0059): everything a deployment checks about a pack, offline. */
describe("typesys pack", () => {
  it("inspects what a pack needs, then signs it and verifies the signature against a trusted key", async () => {
    const inspected = await typesys("pack", "inspect", airforce);
    expect(inspected).toMatchObject({ code: 0, out: { name: "airforce", requires: { core: "^1.0.0" }, counts: { types: 4, actions: 2 } } });
    expect((inspected.out.requirements as { policies: string[] }).policies).toContain("airforce.read-aircraft");

    const dir = await mkdtemp(path.join(tmpdir(), "typesys-pack-"));
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const other = generateKeyPairSync("ed25519");
    const [key, pub, otherPub, signed] = ["wing.pem", "wing.pub", "other.pub", "signed.json"].map((f) => path.join(dir, f)) as [string, string, string, string];
    await writeFile(key, privateKey.export({ type: "pkcs8", format: "pem" }));
    await writeFile(pub, publicKey.export({ type: "spki", format: "pem" }));
    await writeFile(otherPub, other.publicKey.export({ type: "spki", format: "pem" }));

    expect(await typesys("pack", "sign", airforce, "--key-id", "wing", "--private-key", key, "--out", signed)).toMatchObject({ code: 0 });
    expect(await typesys("pack", "verify", signed, "--trust", `wing=${pub}`)).toMatchObject({ code: 0, out: { ok: true, diagnostics: [] } });
    expect(await typesys("pack", "verify", signed, "--trust", `wing=${otherPub}`)).toMatchObject({ code: 1, out: { diagnostics: [{ code: "bad-signature" }, { code: "untrusted" }] } });

    const tampered = JSON.parse(await readFile(signed, "utf8")) as { description: string };
    tampered.description = "Something else";
    await writeFile(signed, JSON.stringify(tampered));
    expect(await typesys("pack", "verify", signed)).toMatchObject({ code: 1, out: { diagnostics: [{ code: "digest-mismatch" }] } });
    expect(await typesys("pack", "sign", signed, "--key-id", "wing", "--private-key", key, "--out", path.join(dir, "again.json"))).toMatchObject({ code: 1 });
  });

  it("checks an upgrade against the installed packs and fails on a finding", async () => {
    const same = await typesys("pack", "check-upgrade", airforce, "--installed", core, "--installed", airforce);
    expect(same).toMatchObject({ code: 1, out: { needs: "patch", made: "none", diagnostics: [{ code: "under-versioned" }] } });
    expect(await typesys("pack", "check-upgrade", airforce, "--installed", core)).toMatchObject({ code: 1, out: { diagnostics: [{ code: "missing-dependency" }] } });
  });

  it("fails a patch upgrade that strips a property policy", async () => {
    const pack = JSON.parse(await readFile(airforce, "utf8")) as PackArchive;
    const types = pack.contents.types.map((t) => (t.name === "airforce.Aircraft" ? { ...t, schema: { ...t.schema, "x-policy": { objectPolicy: "airforce.read-aircraft" } } } : t));
    const body = { ...pack, version: "1.0.1", contents: { ...pack.contents, types } };
    const stripped = { ...body, requirements: requirementsOf(body.contents) };
    const file = path.join(await mkdtemp(path.join(tmpdir(), "typesys-pack-")), "stripped.json");
    await writeFile(file, JSON.stringify({ ...stripped, digest: digestOf(stripped) }));
    const report = await typesys("pack", "check-upgrade", file, "--installed", core, "--installed", airforce);
    expect(report.code).toBe(1);
    expect((report.out.diagnostics as { code: string }[]).map((d) => d.code)).toContain("protection-weakened");
  });
});
