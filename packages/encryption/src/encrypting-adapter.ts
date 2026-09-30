import {
  AggregationNotSupportedError,
  parseResolution,
  type ActionContext,
  type ActionDefinition,
  type Adapter,
  type AdapterCallOptions,
  type AdapterQueryResult,
  type AggregateResult,
  type ProvenanceRef,
  type QueryFilter,
  type RelatedRef,
  type RelationshipDefinition,
  type ResolvedProperties,
  type SemanticAggregateQuery,
  type SortKey
} from "@typesys/core";
import { FieldCipher, type FieldRef } from "./cipher.js";
import { EncryptedFieldError, EncryptionConfigError } from "./errors.js";
import type { KeyProvider } from "./keys.js";

/**
 * `randomized` (the default): a fresh ciphertext every write, so the store
 * can't tell equal values apart. `deterministic`: the same, plus an
 * HMAC-SHA-256 blind index beside it, so `eq` / `ne` / `in` filters still
 * work — at the cost of revealing which records share a value.
 */
export type EncryptionMode = "randomized" | "deterministic";

export interface EncryptionConfig {
  /** The encrypted fields of each Type: `{ "hospital.Patient": { medicalRecordNumber: { mode: "deterministic" }, dateOfBirth: {} } }`. */
  fields: Record<string, Record<string, { mode?: EncryptionMode }>>;
  /**
   * Every Action the wrapped adapter executes, mapped to the Type whose
   * fields its input writes (encrypted before the adapter sees them, and
   * decrypted in its result) — or to `null` if it writes no encrypted field.
   * An Action not listed is refused: it could write a protected field in
   * plaintext.
   */
  actions?: Record<string, string | null>;
}

/** Stored beside a deterministic field, and never shown: `__bidx_<field>`. Reserved — no write or filter may name it. */
export const BLIND_INDEX_PREFIX = "__bidx_";
const blindIndexOf = (field: string) => `${BLIND_INDEX_PREFIX}${field}`;
const isReserved = (name: string) => name.startsWith(BLIND_INDEX_PREFIX);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function refuseReserved(names: Iterable<string>, where: string): void {
  for (const name of names) {
    if (isReserved(name)) throw new EncryptedFieldError(`${where} names "${name}", reserved for encrypted fields' blind indexes`);
  }
}

/**
 * Field-level encryption at rest, as a decorator around any `Adapter`
 * (ADR-0033). The inner adapter — and so every store behind it — only ever
 * holds ciphertext for the configured fields; the runtime, and everything it
 * enforces, only ever sees plaintext. Operations that would need plaintext
 * in the store are refused with `EncryptedFieldError`, and a value that
 * doesn't decrypt fails the read with `DecryptionError`.
 */
export class EncryptingAdapter implements Adapter {
  readonly dataSourceId: string;
  private readonly cipher: FieldCipher;
  private readonly fields: ReadonlyMap<string, ReadonlyMap<string, EncryptionMode>>;
  private readonly actions: Readonly<Record<string, string | null>>;

  constructor(
    private readonly inner: Adapter,
    keys: KeyProvider,
    config: EncryptionConfig
  ) {
    this.dataSourceId = inner.dataSourceId;
    this.cipher = new FieldCipher(keys);
    this.actions = config.actions ?? {};
    this.fields = new Map(
      Object.entries(config.fields).map(([typeName, fields]) => [
        typeName,
        new Map(
          Object.entries(fields).map(([field, { mode = "randomized" }]) => {
            if (isReserved(field)) throw new EncryptionConfigError(`${typeName}.${field}: the "${BLIND_INDEX_PREFIX}" prefix is reserved`);
            if (mode !== "randomized" && mode !== "deterministic") throw new EncryptionConfigError(`${typeName}.${field}: unknown mode "${String(mode)}"`);
            return [field, mode];
          })
        )
      ])
    );
  }

  private modeOf(ref: FieldRef): EncryptionMode | undefined {
    return this.fields.get(ref.typeName)?.get(ref.field);
  }

  private refuse(ref: FieldRef, what: string, hint: string): never {
    throw new EncryptedFieldError(`Cannot ${what} encrypted field ${ref.typeName}.${ref.field}: the store holds only its ciphertext. ${hint}`);
  }

  /**
   * A record's stored form: each encrypted field replaced by its envelope,
   * and a blind index beside each deterministic one. What a bulk load must
   * write through an adapter's own method (`seed`, `put`), so no plaintext
   * reaches the store.
   */
  async seal(typeName: string, values: Record<string, unknown>): Promise<Record<string, unknown>> {
    refuseReserved(Object.keys(values), `A write to ${typeName}`);
    const sealed = { ...values };
    for (const [field, mode] of this.fields.get(typeName) ?? []) {
      if (!Object.hasOwn(values, field) || values[field] === undefined) continue;
      const ref = { typeName, field };
      sealed[field] = await this.cipher.encrypt(ref, values[field]);
      if (mode === "deterministic") sealed[blindIndexOf(field)] = await this.cipher.activeIndex(ref, values[field]);
    }
    return sealed;
  }

  /** The plaintext form of a stored record: fields decrypted (and deterministic ones' indexes verified), every reserved field removed. */
  private async unseal(typeName: string, objectId: string, stored: Record<string, unknown>): Promise<Record<string, unknown>> {
    const open = Object.fromEntries(Object.entries(stored).filter(([name]) => !isReserved(name)));
    for (const [field, mode] of this.fields.get(typeName) ?? []) {
      if (!Object.hasOwn(stored, field)) continue;
      const ref = { typeName, field };
      const value = await this.cipher.decrypt(ref, stored[field], objectId);
      if (mode === "deterministic") await this.cipher.verifyIndex(ref, value, stored[blindIndexOf(field)], objectId);
      open[field] = value;
    }
    return open;
  }

  private visible(provenance: ProvenanceRef[]): ProvenanceRef[] {
    return provenance.filter((p) => !isReserved(p.propertyPath));
  }

  /** A filter over plaintext, as one over the stored form: equality on a deterministic field becomes a lookup of its blind index. */
  private async rewrite(typeName: string, filter: QueryFilter): Promise<QueryFilter> {
    if ("and" in filter) return { and: await Promise.all(filter.and.map((f) => this.rewrite(typeName, f))) };
    if ("or" in filter) return { or: await Promise.all(filter.or.map((f) => this.rewrite(typeName, f))) };
    refuseReserved([filter.property], "A filter");
    const ref = { typeName, field: filter.property };
    const mode = this.modeOf(ref);
    if (!mode) return filter;

    const operation = filter.operator === "icontains" ? "search" : `filter with "${filter.operator}" on`;
    const hint =
      filter.operator === "icontains"
        ? "Name search.properties without it."
        : mode === "deterministic"
          ? "A deterministic field supports eq, ne, and in."
          : "Make it deterministic to filter it by equality.";
    if (mode !== "deterministic" || !["eq", "ne", "in"].includes(filter.operator)) this.refuse(ref, operation, hint);

    const property = blindIndexOf(filter.property);
    if (filter.operator === "in") {
      // A non-array `in` matches nothing; kept as it is, against the index, it still matches nothing.
      if (!Array.isArray(filter.value)) return { property, operator: "in", value: filter.value };
      return { property, operator: "in", value: (await Promise.all(filter.value.map((v) => this.cipher.indexes(ref, v)))).flat() };
    }
    const indexes = await this.cipher.indexes(ref, filter.value);
    if (filter.operator === "eq") return { property, operator: "in", value: indexes };
    return { and: indexes.map((value) => ({ property, operator: "ne", value })) };
  }

  private refuseSort(typeName: string, sort: SortKey[] | undefined): void {
    for (const key of sort ?? []) {
      refuseReserved([key.property], "A sort");
      const ref = { typeName, field: key.property };
      if (this.modeOf(ref)) this.refuse(ref, "sort on", "Sort the results after they are read.");
    }
  }

  async resolveProperties(typeName: string, objectId: string, propertyNames: string[], opts?: AdapterCallOptions): Promise<ResolvedProperties> {
    const resolved = await this.inner.resolveProperties(typeName, objectId, propertyNames, opts);
    return { values: await this.unseal(typeName, objectId, resolved.values), provenance: this.visible(resolved.provenance) };
  }

  async queryByType(
    typeName: string,
    filter?: QueryFilter,
    limit?: number,
    cursor?: string,
    sort?: SortKey[],
    opts?: AdapterCallOptions
  ): Promise<AdapterQueryResult> {
    this.refuseSort(typeName, sort);
    const stored = filter ? await this.rewrite(typeName, filter) : undefined;
    const result = await this.inner.queryByType(typeName, stored, limit, cursor, sort, opts);
    const items = await Promise.all(
      result.items.map(async (item) => ({
        objectId: item.objectId,
        values: await this.unseal(typeName, item.objectId, item.values),
        provenance: this.visible(item.provenance)
      }))
    );
    return { ...result, items };
  }

  /** A relationship the store resolves by comparing field values can't compare ciphertexts, so one keyed on an encrypted field is refused. */
  async resolveRelationship(relationship: RelationshipDefinition, sourceObjectId: string, opts?: AdapterCallOptions): Promise<RelatedRef[]> {
    const strategy = parseResolution(relationship.resolution.operation);
    const { sourceType, targetType } = relationship;
    const keyFields: FieldRef[] =
      strategy.kind === "byForeignKey"
        ? [{ typeName: targetType, field: strategy.field }]
        : strategy.kind === "byOwnField"
          ? [{ typeName: sourceType, field: strategy.field }]
          : strategy.kind === "byJoinTable"
            ? [strategy.sourceKey, strategy.targetKey].map((field) => ({ typeName: strategy.joinType, field }))
            : strategy.keys.flatMap((k) => [
                { typeName: targetType, field: k.targetField },
                { typeName: sourceType, field: k.sourceField }
              ]);
    for (const ref of keyFields) {
      if (this.modeOf(ref)) this.refuse(ref, `resolve relationship "${relationship.name}" through`, "Key the relationship on an unencrypted field.");
    }
    return this.inner.resolveRelationship(relationship, sourceObjectId, opts);
  }

  async aggregate(query: SemanticAggregateQuery, opts?: AdapterCallOptions): Promise<AggregateResult> {
    if (typeof this.inner.aggregate !== "function") {
      throw new AggregationNotSupportedError(`Data source "${this.dataSourceId}" for type "${query.type}" does not support aggregation`);
    }
    for (const field of [...(query.groupBy ?? []), ...query.aggregations.flatMap((a) => (a.property ? [a.property] : []))]) {
      refuseReserved([field], "An aggregation");
      const ref = { typeName: query.type, field };
      if (this.modeOf(ref)) this.refuse(ref, "group or aggregate", "Aggregate after decrypting, over a bounded set.");
    }
    const filter = query.filter ? await this.rewrite(query.type, query.filter) : undefined;
    return this.inner.aggregate({ ...query, ...(filter ? { filter } : {}) }, opts);
  }

  async executeAction(action: ActionDefinition, input: unknown, ctx: ActionContext, opts?: AdapterCallOptions): Promise<unknown> {
    if (!Object.hasOwn(this.actions, action.name)) {
      throw new EncryptionConfigError(
        `Action "${action.name}" isn't in the encryption config's actions, so it could write an encrypted field in plaintext; ` +
          `map it to the Type its input writes, or to null if it writes none`
      );
    }
    const typeName = this.actions[action.name];
    if (typeName === null || typeName === undefined) return this.inner.executeAction(action, input, ctx, opts);
    const result = await this.inner.executeAction(action, isRecord(input) ? await this.seal(typeName, input) : input, ctx, opts);
    return isRecord(result) ? this.unseal(typeName, typeof result.id === "string" ? result.id : "(action result)", result) : result;
  }
}
