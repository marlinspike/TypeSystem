import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEMO_LINEAR_CLASSIFICATION, SemanticRuntime, type Adapter, type Identity } from "@typesys/core";
import { InMemoryRepositoryAdapter } from "@typesys/adapter-in-memory";
import { buildAirforceTestbed } from "@typesys/domain-airforce";
import { buildHospitalTestbed } from "@typesys/domain-hospital";
import { EncryptingAdapter, LocalKeyProvider, type EncryptionConfig, type EncryptionMode } from "@typesys/encryption";
import { CedarPolicyEngine } from "@typesys/policy-cedar";

// ---------------------------------------------------------------------------
// Encryption at rest (ADR-0033)
// ---------------------------------------------------------------------------

/** The Patient PHI the demo keeps as ciphertext in its store. The two deterministic fields stay equality-searchable. */
export const ENCRYPTION_CONFIG: EncryptionConfig = {
  fields: {
    "hospital.Patient": {
      medicalRecordNumber: { mode: "deterministic" },
      assignedClinicianId: { mode: "deterministic" },
      dateOfBirth: {}
    }
  },
  actions: {}
};

/** `{ "hospital.Patient": { medicalRecordNumber: "deterministic", … } }`, for the UI. */
export function encryptedFieldModes(): Record<string, Record<string, EncryptionMode>> {
  return Object.fromEntries(
    Object.entries(ENCRYPTION_CONFIG.fields).map(([type, fields]) => [type, Object.fromEntries(Object.entries(fields).map(([f, c]) => [f, c.mode ?? "randomized"]))])
  );
}

/** A retired and an active key, both generated at startup: demo keys, not a key management system. */
export const KEY_IDS = { retired: "demo-2026-06", active: "demo-2026-09" } as const;
const keyMaterial = { [KEY_IDS.retired]: randomBytes(32), [KEY_IDS.active]: randomBytes(32) };
const keysWithActive = (active: string) => new LocalKeyProvider({ keys: keyMaterial, active });
export const demoKeys = keysWithActive(KEY_IDS.active);

export interface EncryptedStore {
  /** Beneath the decorator: what the store actually holds. */
  inner: InMemoryRepositoryAdapter;
  /** What the runtime is given. */
  adapter: EncryptingAdapter;
}

/**
 * The hospital records re-loaded into a store behind an `EncryptingAdapter`.
 * The first patient is sealed as if before a key rotation, under the retired
 * key, so the keyring visibly serves both: old values keep decrypting, new
 * ones use the active key.
 */
export async function encryptedHospitalStore(plain: Adapter, dataSourceId: string): Promise<EncryptedStore> {
  const inner = new InMemoryRepositoryAdapter(dataSourceId, "hospital-repo");
  const adapter = new EncryptingAdapter(inner, demoKeys, ENCRYPTION_CONFIG);
  const beforeRotation = new EncryptingAdapter(inner, keysWithActive(KEY_IDS.retired), ENCRYPTION_CONFIG);
  for (const type of ["hospital.Patient", "hospital.Provider", "hospital.Appointment"]) {
    const { items } = await plain.queryByType(type);
    inner.seed(
      type,
      await Promise.all(
        items.map(async (item, i) => ({ objectId: item.objectId, values: await (i === 0 ? beforeRotation : adapter).seal(type, item.objectId, item.values) }))
      )
    );
  }
  return { inner, adapter };
}

/**
 * Flips one character of a stored ciphertext and reads it back — in a
 * one-record sandbox, so the demo's real store is never touched.
 */
export async function tamperedRead(store: EncryptedStore, objectId: string, field: string) {
  const stored = (await store.inner.resolveProperties("hospital.Patient", objectId, [])).values;
  const envelope = stored[field];
  if (typeof envelope !== "string") return { error: `${field} of ${objectId} is not stored encrypted` };
  const at = envelope.length - 30;
  const tampered = envelope.slice(0, at) + (envelope[at] === "A" ? "B" : "A") + envelope.slice(at + 1);

  const sandbox = new InMemoryRepositoryAdapter("sandbox");
  sandbox.seed("hospital.Patient", [{ objectId, values: { ...stored, [field]: tampered } }]);
  const outcome = await new EncryptingAdapter(sandbox, demoKeys, ENCRYPTION_CONFIG).resolveProperties("hospital.Patient", objectId, []).then(
    () => ({ decrypted: true as const }),
    (err: unknown) => ({ decrypted: false as const, error: (err as Error).name, message: (err as Error).message })
  );
  return { field, original: envelope, tampered, position: at, ...outcome };
}

/**
 * Moves one record's stored ciphertext into another record — in a sandbox
 * copy — and reads the second record back: the envelope is bound to its
 * record (ADR-0035), so the swap fails authentication.
 */
export async function swappedRead(store: EncryptedStore, from: string, to: string, field: string) {
  const [source, target] = await Promise.all([from, to].map(async (id) => (await store.inner.resolveProperties("hospital.Patient", id, [])).values));
  if (!source || !target || typeof source[field] !== "string") return { error: `${field} of ${from} is not stored encrypted` };
  const sandbox = new InMemoryRepositoryAdapter("sandbox");
  sandbox.seed("hospital.Patient", [{ objectId: to, values: { ...target, [field]: source[field] } }]);
  const outcome = await new EncryptingAdapter(sandbox, demoKeys, ENCRYPTION_CONFIG).resolveProperties("hospital.Patient", to, []).then(
    () => ({ decrypted: true as const }),
    (err: unknown) => ({ decrypted: false as const, error: (err as Error).name, message: (err as Error).message })
  );
  return { field, from, to, moved: source[field], ...outcome };
}

// ---------------------------------------------------------------------------
// Two policy engines (ADR-0031)
// ---------------------------------------------------------------------------

const example = (name: string) => readFileSync(fileURLToPath(import.meta.resolve(`@typesys/policy-cedar/examples/${name}`)), "utf8");
export const CEDAR_SCHEMA = example("demo-domains.cedarschema");
export const CEDAR_POLICIES = example("demo-domains.cedar");

export function cedarEngine(): CedarPolicyEngine {
  return new CedarPolicyEngine({
    schema: CEDAR_SCHEMA,
    policies: CEDAR_POLICIES,
    onError: (detail) => console.warn("Cedar decision failed closed", detail)
  });
}

const stable = (value: unknown): string => JSON.stringify(value, (key, v: unknown) => (key === "retrievedAt" ? undefined : v));

async function settle(run: () => Promise<unknown>) {
  try {
    return { ok: stable(await run()) };
  } catch (err) {
    const e = err as Error & { reason?: string };
    return { error: `${e.name}: ${e.message}`, reason: e.reason };
  }
}

/**
 * Every read path, for every object, as every identity — once on each
 * domain's own `AbacPolicyEngine` rules and once on `CedarPolicyEngine`, in
 * fresh worlds so the demo's audit log isn't flooded. The full proof is
 * `packages/policy-cedar/test/parity.test.ts`; this is the live version.
 */
export async function engineParity(identities: Record<string, Identity>) {
  const worlds = await Promise.all(
    [0, 1].map(async () => {
      const [air, hospital] = [await buildAirforceTestbed({ mockRestLatencyMs: 0 }), await buildHospitalTestbed()];
      return { air, hospital };
    })
  );
  const [abac, cedarWorld] = worlds as [(typeof worlds)[0], (typeof worlds)[0]];
  const engine = cedarEngine();
  // The same classification scheme the ABAC testbeds configure (ADR-0034), so only the engine differs.
  const options = { classification: DEMO_LINEAR_CLASSIFICATION };
  const cedar = {
    air: new SemanticRuntime(cedarWorld.air.registry, [cedarWorld.air.inMemoryAdapter, cedarWorld.air.mockRestAdapter], engine, options),
    hospital: new SemanticRuntime(cedarWorld.hospital.registry, [cedarWorld.hospital.adapter], engine, options)
  };

  const targets: { domain: "air" | "hospital"; type: string; adapter: Adapter }[] = [
    ...["airforce.Aircraft", "airforce.Component"].map((type) => ({ domain: "air" as const, type, adapter: abac.air.inMemoryAdapter })),
    ...["airforce.MaintenanceEvent"].map((type) => ({ domain: "air" as const, type, adapter: abac.air.mockRestAdapter })),
    ...["hospital.Patient", "hospital.Provider", "hospital.Appointment"].map((type) => ({ domain: "hospital" as const, type, adapter: abac.hospital.adapter }))
  ];

  type Scenario = { label: string; domain: "air" | "hospital"; run: (rt: SemanticRuntime) => Promise<unknown> };
  const scenarios: Scenario[] = [];
  for (const [name, who] of Object.entries(identities)) {
    for (const { domain, type, adapter } of targets) {
      scenarios.push({ label: `${name}: query ${type}`, domain, run: (rt) => rt.query({ type }, who) });
      for (const { objectId } of (await adapter.queryByType(type)).items) {
        scenarios.push({ label: `${name}: read ${type}/${objectId}`, domain, run: (rt) => rt.getObject(type, objectId, who, { includeProvenance: true }) });
      }
    }
    scenarios.push({ label: `${name}: count patients`, domain: "hospital", run: (rt) => rt.aggregate({ type: "hospital.Patient", aggregations: [{ name: "n", op: "count" }] }, who) });
    scenarios.push({ label: `${name}: list actions`, domain: "air", run: (rt) => rt.listActions("airforce.MaintenanceEvent", who) });
  }

  let identical = 0;
  const samples: { label: string; abac?: string; cedar?: string }[] = [];
  const mismatches: string[] = [];
  const seenReasons = new Set<string>();
  for (const s of scenarios) {
    const a = await settle(() => s.run(s.domain === "air" ? abac.air.runtime : abac.hospital.runtime));
    const c = await settle(() => s.run(cedar[s.domain]));
    if (("ok" in a && "ok" in c && a.ok === c.ok) || ("error" in a && "error" in c && a.error === c.error)) identical++;
    else mismatches.push(s.label);
    // A few denials, one per distinct ABAC reason: the same verdict, worded by each engine.
    if ("error" in a && a.reason && "error" in c && !seenReasons.has(a.reason) && samples.length < 8) {
      seenReasons.add(a.reason);
      samples.push({ label: s.label, abac: a.reason, cedar: c.reason });
    }
  }
  return { scenarios: scenarios.length, identical, mismatches, samples };
}
