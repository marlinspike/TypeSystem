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

  /**
   * Simulated network latency, cooperatively cancellable (ADR-0026): if the
   * runtime's per-call deadline aborts the signal mid-flight, the pending
   * call rejects immediately instead of running out its latency — the
   * behavior a real HTTP client with an `AbortSignal` would exhibit.
   */
  private delay(signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("MockRestClient request aborted"));
        return;
      }
      const timer = setTimeout(resolve, this.latencyMs);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new Error("MockRestClient request aborted"));
        },
        { once: true }
      );
    });
  }

  seedMaintenanceEvents(records: ExternalMaintenanceRecord[]): void {
    for (const record of records) this.maintenanceEvents.set(record.event_id, record);
  }

  seedWorkOrders(records: ExternalWorkOrderRecord[]): void {
    for (const record of records) this.workOrders.set(record.wo_id, record);
    this.nextWorkOrderSeq = this.workOrders.size + 1;
  }

  async getMaintenanceEvent(eventId: string, signal?: AbortSignal): Promise<ExternalMaintenanceRecord | undefined> {
    await this.delay(signal);
    return this.maintenanceEvents.get(eventId);
  }

  async listAllMaintenanceEvents(signal?: AbortSignal): Promise<ExternalMaintenanceRecord[]> {
    await this.delay(signal);
    return [...this.maintenanceEvents.values()];
  }

  async getWorkOrder(id: string, signal?: AbortSignal): Promise<ExternalWorkOrderRecord | undefined> {
    await this.delay(signal);
    return this.workOrders.get(id);
  }

  async listAllWorkOrders(signal?: AbortSignal): Promise<ExternalWorkOrderRecord[]> {
    await this.delay(signal);
    return [...this.workOrders.values()];
  }

  async createWorkOrder(
    input: { event_id: string; assigned_to: string; status?: string },
    signal?: AbortSignal
  ): Promise<ExternalWorkOrderRecord> {
    await this.delay(signal);
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
