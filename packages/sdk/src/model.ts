import type { UnavailablePart } from "@typesys/core";

/**
 * The static shape of a TypeSys model, as `generateModel` emits it from a
 * registry (ADR-0055). It is a type only: nothing here exists at run time, so
 * the model a client is typed against is never a second schema to keep in
 * step with the registry, only a generated view of it, checked for drift by
 * regenerating.
 */
export interface ModelShape {
  readonly types: { readonly [name: string]: TypeShape };
  readonly actions: { readonly [name: string]: ActionShape };
}

export interface TypeShape {
  /** Stored properties, own, inherited, and from traits. */
  readonly props: object;
  /** Computed properties, typed by each one's declared value schema. */
  readonly computed: object;
  readonly rels: { readonly [name: string]: RelationshipShape };
  /** The names of the Actions that apply to this Type (`never` when none). */
  readonly actions: string;
}

export interface RelationshipShape {
  readonly target: string;
  readonly many: boolean;
}

export interface ActionShape {
  readonly input: object;
  readonly output: unknown;
  /** The Type an instance-scoped Action acts on, or `null` for one decided per Type (ADR-0053). */
  readonly target: string | null;
}

export type TypeName<M extends ModelShape> = keyof M["types"] & string;
export type ActionName<M extends ModelShape> = keyof M["actions"] & string;

/** Every readable value of a Type: stored and computed. */
export type Values<M extends ModelShape, N extends TypeName<M>> = M["types"][N]["props"] & M["types"][N]["computed"];
export type ValueKey<M extends ModelShape, N extends TypeName<M>> = keyof Values<M, N> & string;
/** Stored properties only: what a source system can sort on. */
export type StoredKey<M extends ModelShape, N extends TypeName<M>> = keyof M["types"][N]["props"] & string;
export type RelationshipName<M extends ModelShape, N extends TypeName<M>> = keyof M["types"][N]["rels"] & string;
export type RelationshipTarget<M extends ModelShape, N extends TypeName<M>, R extends RelationshipName<M, N>> = M["types"][N]["rels"][R]["target"] &
  TypeName<M>;

/**
 * One object as the SDK returns it: its id and Type beside its values, and
 * each included relationship as an array. Every value is optional, whatever
 * the schema requires: policy, classification, and derivation (ADR-0030,
 * ADR-0032, ADR-0052) may withhold any of them from any caller, and a type
 * that promised otherwise would be a lie the first time one did.
 */
export type Row<M extends ModelShape, N extends TypeName<M>, K extends ValueKey<M, N> = ValueKey<M, N>, I = unknown> = {
  readonly $id: string;
  readonly $type: N;
  /** Included relationships left out because their source failed, and why (ADR-0072). Absent when nothing was. */
  readonly $unavailable?: readonly UnavailablePart[];
} & { readonly [P in K]?: Values<M, N>[P] } & I;
