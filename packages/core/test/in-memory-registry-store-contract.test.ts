import { describe, it, expect, beforeEach } from "vitest";
import { runRegistryStoreContractTests } from "../src/testing/registry-store-contract.js";
import { InMemoryRegistryStore } from "../src/registry/in-memory-registry-store.js";

runRegistryStoreContractTests({ describe, it, expect, beforeEach }, "InMemoryRegistryStore", async () => new InMemoryRegistryStore());
