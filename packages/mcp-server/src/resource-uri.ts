/**
 * `typesys://` resource URIs. Kept as plain string building/parsing rather
 * than the SDK's ResourceTemplate class — the vertical slice's URI shapes
 * are simple enough that a template engine would be speculative (see
 * "avoid speculative abstraction" in the quality bar).
 */
export const SCHEME = "typesys";

function withToken(base: string, token?: string): string {
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}

export function buildTypeListUri(): string {
  return `${SCHEME}://types`;
}

export function buildTypeUri(typeName: string): string {
  return `${SCHEME}://types/${encodeURIComponent(typeName)}`;
}

export function buildObjectUri(typeName: string, objectId: string, token?: string): string {
  return withToken(`${SCHEME}://objects/${encodeURIComponent(typeName)}/${encodeURIComponent(objectId)}`, token);
}

export function buildRelationshipUri(typeName: string, objectId: string, relationshipName: string, token?: string): string {
  return withToken(
    `${SCHEME}://objects/${encodeURIComponent(typeName)}/${encodeURIComponent(objectId)}/relationships/${encodeURIComponent(relationshipName)}`,
    token
  );
}

export function buildProvenanceUri(typeName: string, objectId: string, propertyPath: string, token?: string): string {
  return withToken(
    `${SCHEME}://objects/${encodeURIComponent(typeName)}/${encodeURIComponent(objectId)}/provenance/${encodeURIComponent(propertyPath)}`,
    token
  );
}

export interface ParsedResourceUri {
  category: string;
  segments: string[];
  token?: string;
}

export function parseResourceUri(uri: string): ParsedResourceUri {
  const withoutScheme = uri.replace(new RegExp(`^${SCHEME}://`), "");
  const [pathPart, queryPart] = withoutScheme.split("?");
  const token = queryPart ? new URLSearchParams(queryPart).get("token") ?? undefined : undefined;
  const allSegments = (pathPart ?? "").split("/").filter(Boolean).map(decodeURIComponent);
  const [category = "", ...segments] = allSegments;
  return { category, segments, token };
}

/**
 * A resource URI as a span may record it (ADR-0047). Never its query or
 * fragment — the bearer token rides in `?token=` — and, when the runtime
 * redacts identifiers, no object id: the category, Type, and the shape of
 * the rest.
 */
export function telemetryResourceUri(uri: string, redactIdentifiers: boolean): string {
  const path = uri.split(/[?#]/, 1)[0] ?? "";
  if (!redactIdentifiers) return path;
  let parsed: ParsedResourceUri;
  try {
    parsed = parseResourceUri(path);
  } catch {
    return `${SCHEME}://{unparseable}`;
  }
  const { category, segments } = parsed;
  if (!path.startsWith(`${SCHEME}://`) || (category !== "types" && category !== "objects")) return `${SCHEME}://{unrecognized}`;
  const shown = segments.map((segment, i) => (category === "objects" && i === 1 ? "{objectId}" : encodeURIComponent(segment)));
  return `${SCHEME}://${[category, ...shown].join("/")}`;
}
