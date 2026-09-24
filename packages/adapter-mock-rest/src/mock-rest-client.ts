/**
 * Stands in for a real external REST-style enterprise system (e.g. a
 * REMIS-like maintenance-tracking service): its own record shape, its own
 * field naming, and simulated network latency. The adapter (not this
 * client) is responsible for translating this shape into the canonical
 * semantic model.
 */
export interface ExternalMaintenanceRecord {
  event_id: string;
  aircraft_tail: string;
  event_type: string;
  event_date: string;
  notes: string;
}

export interface ExternalWorkOrderRecord {
  wo_id: string;
  event_id: string;
  status: string;
  assigned_to: string;
  created_at: string;
}

export class MockRestClient {
  private readonly maintenanceEvents = new Map<string, ExternalMaintenanceRecord>();
  private readonly workOrders = new Map<string, ExternalWorkOrderRecord>();
  private nextWorkOrderSeq = 1;

  constructor(private readonly latencyMs: number = 5) {}

  private delay(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, this.latencyMs));
  }

  seedMaintenanceEvents(records: ExternalMaintenanceRecord[]): void {
    for (const record of records) this.maintenanceEvents.set(record.event_id, record);
  }

  seedWorkOrders(records: ExternalWorkOrderRecord[]): void {
    for (const record of records) this.workOrders.set(record.wo_id, record);
    this.nextWorkOrderSeq = this.workOrders.size + 1;
  }

  async getMaintenanceEvent(eventId: string): Promise<ExternalMaintenanceRecord | undefined> {
    await this.delay();
    return this.maintenanceEvents.get(eventId);
  }

  async listAllMaintenanceEvents(): Promise<ExternalMaintenanceRecord[]> {
    await this.delay();
    return [...this.maintenanceEvents.values()];
  }

  async getWorkOrder(id: string): Promise<ExternalWorkOrderRecord | undefined> {
    await this.delay();
    return this.workOrders.get(id);
  }

  async listAllWorkOrders(): Promise<ExternalWorkOrderRecord[]> {
    await this.delay();
    return [...this.workOrders.values()];
  }

  async createWorkOrder(input: { event_id: string; assigned_to: string; status?: string }): Promise<ExternalWorkOrderRecord> {
    await this.delay();
    const record: ExternalWorkOrderRecord = {
      wo_id: `WO-${String(this.nextWorkOrderSeq++).padStart(4, "0")}`,
      event_id: input.event_id,
      status: input.status ?? "open",
      assigned_to: input.assigned_to,
      created_at: new Date().toISOString()
    };
    this.workOrders.set(record.wo_id, record);
    return record;
  }
}
