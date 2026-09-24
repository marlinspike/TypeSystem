import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { SEMANTIC_X_KEYWORDS } from "../model/vocabulary.js";

/**
 * Ajv's default strict mode throws on unrecognized keywords. The x-*
 * vocabulary keywords must be registered as annotation-only keywords
 * (Ajv's string-form addKeyword) *before* any Semantic Type Descriptor is
 * compiled, or registration of the very first type throws. This is the
 * single riskiest line in the whole registry — get it wrong and nothing
 * validates.
 */
export function createSemanticValidator(): Ajv2020 {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  for (const keyword of SEMANTIC_X_KEYWORDS) {
    ajv.addKeyword(keyword);
  }
  return ajv;
}

export class SchemaValidationError extends Error {
  constructor(
    message: string,
    public readonly errors: unknown
  ) {
    super(message);
    this.name = "SchemaValidationError";
  }
}
