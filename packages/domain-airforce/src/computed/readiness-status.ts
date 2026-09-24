import type { ComputeContext } from "@typesys/core";

/**
 * Aircraft.readinessStatus — the vertical slice's one required computed
 * property. Deliberately simple: derived live from `maintenanceStatus`
 * rather than materialized, since it has exactly one dependency and no
 * expensive fan-out (see ADR-0007).
 */
export async function computeReadinessStatus(ctx: ComputeContext): Promise<string> {
  const maintenanceStatus = await ctx.getProperty("maintenanceStatus");
  switch (maintenanceStatus) {
    case "down":
      return "NMC"; // Not Mission Capable
    case "degraded":
      return "PMC"; // Partially Mission Capable
    case "operational":
      return "FMC"; // Fully Mission Capable
    default:
      return "UNKNOWN";
  }
}
