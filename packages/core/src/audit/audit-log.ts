export interface AuditEvent {
  id: string;
  timestamp: string;
  subjectId: string;
  /**
   * The runtime operation the row was written under — the outermost call:
   * `query` for a decision inside a query's include, `listActions` for a
   * preview (ADR-0042). Absent on rows written before it existed.
   */
  operation?: string;
  action: string;
  resource: { typeName: string; objectId?: string; propertyPath?: string };
  decision: "allow" | "deny";
  reason?: string;
  outcome?: "success" | "failure";
  details?: Record<string, unknown>;
}

export interface AuditSink {
  append(event: AuditEvent): Promise<void>;
  list(): Promise<AuditEvent[]>;
}

export class InMemoryAuditSink implements AuditSink {
  private readonly events: AuditEvent[] = [];

  async append(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }

  async list(): Promise<AuditEvent[]> {
    return [...this.events];
  }
}
