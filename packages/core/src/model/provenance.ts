/**
 * Provenance is a first-class capability but is not forced onto every
 * resolved value by default — it is retrievable on demand (explicit
 * `getProvenance` call, or an opt-in `includeProvenance` query flag).
 */
export interface ProvenanceRef {
  propertyPath: string;
  source: {
    dataSourceId: string;
    system: string;
    recordId?: string;
    field?: string;
  };
  observedAt?: string;
  retrievedAt: string;
  confidence?: number;
  classification?: string;
}
