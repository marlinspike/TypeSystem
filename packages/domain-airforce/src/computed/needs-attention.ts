import type { ComputeContext } from "@typesys/core";
import { MAINTENANCE_DATA_SOURCE_ID } from "../data-source-ids.js";

/**
 * Aircraft.needsAttention — a boolean signal combining two genuinely
 * different sources into one value (ADR-0022): the Aircraft's own
 * `maintenanceStatus` (its home data source, resolved via `ctx.getProperty`
 * exactly like `computeReadinessStatus` above), OR'd with whether any open
 * work order exists against this aircraft's maintenance history — reached
 * live via `ctx.getAdapter(MAINTENANCE_DATA_SOURCE_ID)`, a completely
 * different adapter than the one serving Aircraft's own properties, and
 * one Aircraft has no direct Mapping to at all.
 *
 * This is a scalar derived from two sources, not a related object — the
 * case where a computed property is the right tool and a relationship
 * would be the wrong shape (see ADR-0022's "Alternatives Considered").
 */
export async function computeNeedsAttention(ctx: ComputeContext): Promise<boolean> {
  const maintenanceStatus = await ctx.getProperty("maintenanceStatus");
  if (maintenanceStatus === "down" || maintenanceStatus === "degraded") return true;

  const maintenanceAdapter = ctx.getAdapter(MAINTENANCE_DATA_SOURCE_ID);
  const events = await maintenanceAdapter.queryByType("airforce.MaintenanceEvent", {
    property: "aircraftId",
    operator: "eq",
    value: ctx.objectId
  });
  if (events.items.length === 0) return false;

  const eventIds = new Set(events.items.map((e) => e.objectId));
  const workOrders = await maintenanceAdapter.queryByType("airforce.WorkOrder");
  return workOrders.items.some(
    (wo) => eventIds.has(wo.values.maintenanceEventId as string) && wo.values.status !== "closed"
  );
}
