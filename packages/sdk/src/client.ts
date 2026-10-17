import type { ActionPreview, ActionSummary, AggregateResult, ProvenanceRef, SemanticAggregateQuery } from "@typesys/core";
import type { ActionName, ModelShape, RelationshipName, RelationshipTarget, Row, TypeName, ValueKey } from "./model.js";
import { Query, toRow } from "./query.js";
import type { Transport } from "./transport.js";

/** An Action listed for a Type or an object, its name narrowed to the Actions the model says apply there. */
export type ListedActionOf<M extends ModelShape, N extends TypeName<M>> = ActionSummary & { readonly name: M["types"][N]["actions"] };

/** One Action, typed by its declared input and output schemas. */
export interface ActionHandle<M extends ModelShape, A extends ActionName<M>> {
  /** What invoking would do, with nothing executed (ADR-0053). */
  readonly preview: (input: M["actions"][A]["input"]) => Promise<ActionPreview>;
  /** The Action's output as its schema declares it; the runtime validates the input, the domain's adapter produces the output. */
  readonly invoke: (input: M["actions"][A]["input"]) => Promise<M["actions"][A]["output"]>;
}

export interface Client<M extends ModelShape> {
  /** A query of one Type, every value selected until `select` narrows it. */
  from<N extends TypeName<M>>(type: N): Query<M, N>;
  /** One object, every value the caller may read. */
  get<N extends TypeName<M>>(type: N, id: string): Promise<Row<M, N>>;
  get<N extends TypeName<M>>(type: N, id: string, opts: { provenance: true }): Promise<Row<M, N, ValueKey<M, N>, { readonly $provenance: readonly ProvenanceRef[] }>>;
  /** The objects one object relates to through a relationship, each one the caller may read. */
  related<N extends TypeName<M>, R extends RelationshipName<M, N>>(type: N, id: string, relationship: R): Promise<Row<M, RelationshipTarget<M, N, R>>[]>;
  /** Where one value came from, inputs included for a computed one (ADR-0022). */
  provenance<N extends TypeName<M>>(type: N, id: string, property: ValueKey<M, N>): Promise<ProvenanceRef[]>;
  /** The Actions on a Type, or on one object of it, and whether this caller may invoke each (ADR-0053). */
  actions<N extends TypeName<M>>(type: N, id?: string): Promise<ListedActionOf<M, N>[]>;
  action<A extends ActionName<M>>(name: A): ActionHandle<M, A>;
  /** Grouped counts and sums over the objects of a Type this caller may read, decided by the runtime (ADR-0027). */
  aggregate<N extends TypeName<M>>(query: SemanticAggregateQuery & { readonly type: N }): Promise<AggregateResult>;
}

/**
 * A client typed by a generated model (ADR-0055):
 * `createClient<AirforceModel>(runtimeTransport(runtime, identity))`. The
 * types describe what may be asked; whether it is answered, and with which
 * values, is still decided by the runtime for this caller on every call.
 */
export function createClient<M extends ModelShape>(transport: Transport): Client<M> {
  return {
    from: (type) => new Query(transport, { type }),
    get: (async (type: string, id: string, opts?: { provenance: true }) => {
      const provenance = opts?.provenance === true;
      return toRow(await transport.getObject(type, id, { includeProvenance: provenance }), undefined, provenance);
    }) as Client<M>["get"],
    related: async (type, id, relationship) => (await transport.getRelationship(type, id, relationship)).map((o) => toRow(o, undefined, false) as never),
    provenance: (type, id, property) => transport.getProvenance(type, id, property),
    actions: (type, id) => transport.listActions(type, id),
    action: (name) => ({
      preview: (input) => transport.previewAction(name, input),
      invoke: (input) => transport.invokeAction(name, input)
    }),
    aggregate: async (query) => {
      if (!transport.aggregate) throw new TypeError("This transport does not carry aggregates");
      return transport.aggregate(query);
    }
  };
}
