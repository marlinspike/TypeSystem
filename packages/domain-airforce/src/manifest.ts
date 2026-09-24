import type { DomainManifest } from "@typesys/core";
import { AircraftType } from "./types/aircraft.js";
import { ComponentType } from "./types/component.js";
import { MaintenanceEventType } from "./types/maintenance-event.js";
import { WorkOrderType } from "./types/work-order.js";
import { CreateMaintenanceWorkOrderAction } from "./actions/create-maintenance-work-order.js";
import { airforceDataSources, airforceMappings } from "./mappings/index.js";

/**
 * Everything the airforce domain contributes to the registry. Registering
 * a brand-new domain (see docs/developer-guide/adding-a-domain.md) means
 * authoring exactly this shape and calling `registerDomain` — no changes
 * to `packages/core`.
 */
export const airforceManifest: DomainManifest = {
  domain: "airforce",
  // Component/Aircraft/MaintenanceEvent/WorkOrder don't extend each other,
  // only core.* types (already registered), so order among them doesn't matter.
  types: [ComponentType, AircraftType, MaintenanceEventType, WorkOrderType],
  actions: [CreateMaintenanceWorkOrderAction],
  dataSources: airforceDataSources,
  mappings: airforceMappings
};
