import type { Adapter } from "../runtime/adapter.js";
import { SemanticRuntime } from "../runtime/runtime.js";
import { SemanticRegistry } from "./registry.js";
import { InMemoryRegistryStore } from "./in-memory-registry-store.js";
import type { RegistryStore } from "./registry-store.js";
import { registerDomain, type DomainManifest } from "./manifest.js";
import { AbacPolicyEngine, type PolicyRule } from "../policy/abac-policy-engine.js";
import type { PolicyEngine } from "../model/policy.js";

export interface BuildRuntimeOptions {
  /** Defaults to a fresh `InMemoryRegistryStore` — pass a `PostgresRegistryStore` for a durable registry. */
  store?: RegistryStore;
  /** Registered in array order — put base/core manifests before domains that extend their types. */
  manifests: DomainManifest[];
  adapters: Adapter[];
  /** Named rules registered into a fresh `AbacPolicyEngine`. Ignored if `policyEngine` is supplied. */
  policyRules?: Record<string, PolicyRule>;
  /** Supply your own PolicyEngine (e.g. an OPA/Cedar-backed one) instead of the default ABAC engine. */
  policyEngine?: PolicyEngine;
}

export interface BuiltRuntime {
  registry: SemanticRegistry;
  runtime: SemanticRuntime;
  policyEngine: PolicyEngine;
}

/**
 * The generic "wire up a registry + runtime" sequence every domain package
 * was re-deriving by hand (see `packages/domain-airforce/src/setup.ts`,
 * which now calls this instead of repeating it). Registers every manifest
 * in order, builds a policy engine from named rules (or accepts one you
 * built yourself), and constructs the `SemanticRuntime` over your adapters.
 * Anything domain-specific — which adapters, how they're seeded, which
 * identities exist — stays in the domain package; this only ever knows
 * about the generic shape.
 */
export async function buildRuntime(opts: BuildRuntimeOptions): Promise<BuiltRuntime> {
  const store = opts.store ?? new InMemoryRegistryStore();
  const registry = new SemanticRegistry(store);

  for (const manifest of opts.manifests) {
    await registerDomain(registry, manifest);
  }

  const policyEngine = opts.policyEngine ?? new AbacPolicyEngine();
  if (!opts.policyEngine && opts.policyRules) {
    for (const [name, rule] of Object.entries(opts.policyRules)) {
      (policyEngine as AbacPolicyEngine).registerRule(name, rule);
    }
  }

  const runtime = new SemanticRuntime(registry, opts.adapters, policyEngine);

  return { registry, runtime, policyEngine };
}
