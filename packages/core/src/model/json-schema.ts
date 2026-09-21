/**
 * Minimal structural typing for a JSON Schema 2020-12 document. Not exhaustive —
 * just enough of the vocabulary this project actually authors against.
 */
export type JsonSchema2020 = {
  type?: string | string[];
  properties?: Record<string, JsonSchema2020>;
  required?: string[];
  items?: JsonSchema2020;
  enum?: unknown[];
  const?: unknown;
  allOf?: JsonSchema2020[];
  anyOf?: JsonSchema2020[];
  oneOf?: JsonSchema2020[];
  $ref?: string;
  $id?: string;
  $schema?: string;
  $dynamicRef?: string;
  $dynamicAnchor?: string;
  $defs?: Record<string, JsonSchema2020>;
  format?: string;
  description?: string;
  title?: string;
  minimum?: number;
  maximum?: number;
  additionalProperties?: boolean | JsonSchema2020;
} & Record<string, unknown>;
