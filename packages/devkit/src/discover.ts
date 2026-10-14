import type { JsonSchema2020, ModelDescription } from "@typesys/core";
import { describeActionCompactly, describeTypeCompactly } from "./catalog.js";
import { tokenize } from "./text.js";

export interface DiscoveryMatch {
  kind: "type" | "action";
  name: string;
  score: number;
  /** The words of the task this entry matched, after tokenizing. */
  matched: string[];
  /** The entry, compactly (`describeTypeCompactly` / `describeActionCompactly`). */
  summary: string;
}

interface Doc {
  kind: DiscoveryMatch["kind"];
  name: string;
  summary: string;
  /** Term frequencies, with names weighted above descriptions. */
  terms: Map<string, number>;
  length: number;
}

/** The string values an enum admits: "closed" is how a task names a WorkOrder status. */
function enumWords(schemas: Iterable<JsonSchema2020>): string {
  return [...schemas].flatMap((s) => (s.enum ?? []).filter((v): v is string => typeof v === "string")).join(" ");
}

function addTerms(terms: Map<string, number>, text: string | undefined, weight: number): number {
  let n = 0;
  for (const t of tokenize(text ?? "")) {
    terms.set(t, (terms.get(t) ?? 0) + weight);
    n += weight;
  }
  return n;
}

function documents(model: ModelDescription): Doc[] {
  const docs: Doc[] = [];
  for (const type of model.types) {
    const terms = new Map<string, number>();
    let length = addTerms(terms, type.name, 3);
    length += addTerms(terms, type.description, 1);
    length += addTerms(terms, Object.keys(type.properties).join(" "), 1);
    length += addTerms(terms, Object.values(type.properties).map((p) => p.description ?? "").join(" "), 1);
    length += addTerms(terms, type.computed.map((c) => c.name).join(" "), 2);
    length += addTerms(terms, type.relationships.map((r) => r.name).join(" "), 1);
    length += addTerms(terms, enumWords(Object.values(type.properties)), 1);
    docs.push({ kind: "type", name: type.name, summary: describeTypeCompactly(type), terms, length });
  }
  for (const action of model.actions) {
    const terms = new Map<string, number>();
    let length = addTerms(terms, action.name, 3);
    length += addTerms(terms, action.description, 1);
    length += addTerms(terms, Object.keys(action.inputSchema.properties ?? {}).join(" "), 1);
    length += addTerms(terms, action.applicableTypes.join(" "), 1);
    length += addTerms(terms, enumWords(Object.values(action.inputSchema.properties ?? {})), 1);
    docs.push({ kind: "action", name: action.name, summary: describeActionCompactly(action), terms, length });
  }
  return docs;
}

/**
 * The Types and Actions most relevant to a task in plain words (ADR-0056),
 * ranked by BM25 over their names (weighted), descriptions, and value,
 * relationship and input names. Lexical and deterministic: it finds
 * "attention" in `needsAttention`, and does not know that "doctor" means
 * `Provider` unless the model's own words say so. An empty task lists
 * everything, unranked, in model order.
 *
 * It reads only the model, which `typesys_list_types` already discloses to
 * any caller; whether a caller may read or invoke what it finds is decided
 * when they do.
 */
export function discover(model: ModelDescription, task: string, opts: { limit?: number } = {}): DiscoveryMatch[] {
  const limit = opts.limit ?? 5;
  const docs = documents(model);
  const query = [...new Set(tokenize(task))];
  if (query.length === 0) return docs.slice(0, limit).map((d) => ({ kind: d.kind, name: d.name, score: 0, matched: [], summary: d.summary }));

  const k1 = 1.2;
  const b = 0.75;
  const avg = docs.reduce((sum, d) => sum + d.length, 0) / Math.max(docs.length, 1);
  const idf = new Map(query.map((t) => {
    const n = docs.filter((d) => d.terms.has(t)).length;
    return [t, Math.log(1 + (docs.length - n + 0.5) / (n + 0.5))];
  }));

  return docs
    .map((d) => {
      let score = 0;
      const matched: string[] = [];
      for (const t of query) {
        const tf = d.terms.get(t);
        if (!tf) continue;
        matched.push(t);
        score += idf.get(t)! * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * d.length) / avg)));
      }
      return { kind: d.kind, name: d.name, score: Math.round(score * 1000) / 1000, matched, summary: d.summary };
    })
    .filter((m) => m.score > 0)
    .sort((x, y) => y.score - x.score || x.name.localeCompare(y.name))
    .slice(0, limit);
}
