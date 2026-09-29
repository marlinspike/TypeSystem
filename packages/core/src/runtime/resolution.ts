/**
 * The closed set of relationship resolution strategies (ADR-0028), parsed
 * once from a `RelationshipDefinition`'s terse `operation` string so every
 * adapter shares one parser instead of re-splitting the string itself — the
 * same "one shared interpreter" property `matchesFilter` and `applySort`
 * have. The string stays the authoring surface (YAML- and agent-friendly);
 * this typed form is what the adapters consume.
 */
export type ResolutionStrategy =
  | { kind: "byForeignKey"; field: string }
  | { kind: "byOwnField"; field: string }
  | { kind: "byJoinTable"; joinType: string; sourceKey: string; targetKey: string; dataSourceId?: string }
  | { kind: "byCompositeKey"; keys: { targetField: string; sourceField: string }[] };

/**
 * Parses an `operation` string into a `ResolutionStrategy`. Grammar:
 * - `byForeignKey:<field>` — target rows whose `<field>` equals the source id.
 * - `byOwnField:<field>` — target ids read from the source object's `<field>`.
 * - `byJoinTable:[<dataSourceId>@]<joinType>/<sourceKey>/<targetKey>` — M:N
 *   through an association collection (`<dataSourceId>@` marks a join that
 *   lives in a different data source; adapters that can't cross sources reject it).
 * - `byCompositeKey:<targetField>=<sourceField>[,<targetField>=<sourceField>...]`
 *   — target rows matching the source on every listed field pair.
 * Throws on a malformed operation (an authoring error in a RelationshipDefinition).
 */
export function parseResolution(operation: string): ResolutionStrategy {
  const colon = operation.indexOf(":");
  const kind = colon === -1 ? operation : operation.slice(0, colon);
  const rest = colon === -1 ? "" : operation.slice(colon + 1);

  switch (kind) {
    case "byForeignKey":
    case "byOwnField": {
      if (!rest) throw new Error(`Relationship operation "${operation}" needs a field: "${kind}:<field>"`);
      return { kind, field: rest };
    }
    case "byJoinTable": {
      let dataSourceId: string | undefined;
      let body = rest;
      const at = body.indexOf("@");
      if (at !== -1) {
        dataSourceId = body.slice(0, at);
        body = body.slice(at + 1);
      }
      const parts = body.split("/");
      if (parts.length !== 3 || parts.some((p) => !p)) {
        throw new Error(
          `Relationship operation "${operation}" must be "byJoinTable:[<dataSourceId>@]<joinType>/<sourceKey>/<targetKey>"`
        );
      }
      return { kind: "byJoinTable", joinType: parts[0]!, sourceKey: parts[1]!, targetKey: parts[2]!, dataSourceId };
    }
    case "byCompositeKey": {
      const keys = rest.split(",").map((pair) => {
        const [targetField, sourceField] = pair.split("=");
        if (!targetField || !sourceField) {
          throw new Error(`Relationship operation "${operation}" pair "${pair}" must be "<targetField>=<sourceField>"`);
        }
        return { targetField, sourceField };
      });
      if (keys.length === 0) {
        throw new Error(`Relationship operation "${operation}" needs at least one "<targetField>=<sourceField>" pair`);
      }
      return { kind: "byCompositeKey", keys };
    }
    default:
      throw new Error(`Unknown relationship resolution strategy "${kind}" in operation "${operation}"`);
  }
}
