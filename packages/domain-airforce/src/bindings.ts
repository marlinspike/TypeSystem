import type { BindingRegistry } from "@typesys/core";
import { computeReadinessStatus } from "./computed/readiness-status.js";
import { maintenanceEventExists } from "./actions/create-maintenance-work-order.js";

/**
 * Every compute/precondition implementation this domain registers,
 * keyed the same way the corresponding `x-computed`/`bindingId` fields
 * name them. Any process that constructs a `PostgresRegistryStore`
 * (ADR-0015) to read the airforce domain back must supply this (or an
 * equivalent) — the in-memory path (`setup.ts`) never needs it, since it
 * holds the live functions directly.
 */
export const airforceBindingRegistry: BindingRegistry = {
  computed: { computeReadinessStatus },
  preconditions: { maintenanceEventExists }
};
