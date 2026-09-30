import type { TypeDefinition } from "../model/type.js";
import type { ProvenanceRef } from "../model/provenance.js";
import type { Identity } from "../model/policy.js";

/** What the data under decision is, and what is being done with it (ADR-0041). */
export interface ClassificationContext {
  readonly action: "read" | "invoke";
  readonly resource: { readonly typeName: string; readonly objectId?: string; readonly propertyPath?: string };
}

export interface ClassificationRequest {
  /** The whole subject: clearance, and whatever attributes the scheme reads. */
  readonly subject: Identity;
  /** A label to decide — never empty; the runtime never asks about unmarked data. */
  readonly markings: readonly string[];
  readonly context: ClassificationContext;
}

export interface ClassificationDecision {
  allow: boolean;
  /** For the audit log only — it may name markings, so the caller never sees it. */
  reason?: string;
}

/**
 * How subjects and data labels compare (ADR-0032, ADR-0034, ADR-0041). The
 * runtime never interprets a marking: it asks `join` for the label of data
 * under several markings — a computed value's, say — and `decide`s that
 * label and every marking on its own, so `join` can only ever add
 * restriction. A scheme must refuse a marking it doesn't recognize.
 */
export interface ClassificationScheme {
  /** Identifies the scheme in audit rows (`details.scheme`), so an operator can tell which one decided. */
  readonly name: string;
  /** The label of data derived from data under all of `markings` — never empty for a non-empty input. */
  join(markings: readonly string[]): readonly string[];
  decide(request: ClassificationRequest): ClassificationDecision;
}

const distinct = (markings: readonly string[]): string[] => [...new Set(markings)];

/** A linear scheme, which also exposes its ordering — lowest first — for display. */
export interface LinearClassificationScheme extends ClassificationScheme {
  readonly levels: readonly string[];
}

/**
 * An ordered scheme, lowest level first. A missing or unrecognized
 * clearance holds only the lowest level; an unrecognized marking is
 * dominated by no clearance. Markings compare as exact strings. The join of
 * several levels is the highest; a marking it doesn't recognize is kept, so
 * the decision still refuses it.
 */
export function linearClassification(levels: readonly string[], name = "linear"): LinearClassificationScheme {
  if (levels.length === 0) throw new TypeError("linearClassification() needs at least one level");
  const rank = new Map(levels.map((level, i) => [level, i]));
  if (rank.size !== levels.length) throw new TypeError("linearClassification() levels must be distinct");
  return {
    name,
    levels: Object.freeze([...levels]),
    join(markings) {
      const known = markings.filter((m) => rank.has(m));
      const highest = known.reduce<string | undefined>((top, m) => (top === undefined || rank.get(m)! > rank.get(top)! ? m : top), undefined);
      return distinct([...(highest === undefined ? [] : [highest]), ...markings.filter((m) => !rank.has(m))]);
    },
    decide({ subject, markings }) {
      const clearance = subject.clearance;
      const held = (clearance === undefined ? undefined : rank.get(clearance)) ?? 0;
      const refused = markings.find((m) => !(rank.has(m) && held >= rank.get(m)!));
      return refused === undefined ? { allow: true } : { allow: false, reason: rank.has(refused) ? `clearance below ${refused}` : `unrecognized marking ${refused}` };
    }
  };
}

/**
 * A demonstration ordering, UNCLASSIFIED < CUI < SECRET < TOP_SECRET — not
 * the US classification model (ADR-0034). Real markings carry compartments
 * and dissemination controls a linear order can't express, and CUI is a
 * separate regime governed by category and lawful purpose, not a level
 * between UNCLASSIFIED and SECRET. Use it for demos and tests; a deployment
 * with real markings needs its own reviewed scheme — `securityLabels` shows
 * the shape of one (ADR-0041).
 */
export const DEMO_LINEAR_CLASSIFICATION = linearClassification(["UNCLASSIFIED", "CUI", "SECRET", "TOP_SECRET"], "demo-linear");

/**
 * The runtime's default (ADR-0034): unmarked data is allowed — it never asks
 * a scheme — and marked data is denied, whatever the subject. So
 * classification enforcement can't be switched off by forgetting to
 * configure it: marked data stays unreadable until a deployment chooses a
 * scheme that can allow it.
 */
export const DENY_MARKED_DATA: ClassificationScheme = Object.freeze({
  name: "deny-marked-data",
  join: (markings: readonly string[]) => distinct(markings),
  decide: () => ({ allow: false, reason: "no classification scheme is configured" })
});

/** A parsed label of the `securityLabels` scheme: every dimension it models. */
interface Label {
  /** Index into `levels`; `undefined` for a CUI-only label. */
  level?: number;
  compartments: Set<string>;
  /** Countries it may be released to; `undefined` means no releasability restriction. */
  releasableTo?: Set<string>;
  /** CUI categories; `undefined` means the data is not CUI. */
  cui?: Set<string>;
}

export interface SecurityLabelsOptions {
  /** Classification levels, lowest first, e.g. `["UNCLASSIFIED", "CONFIDENTIAL", "SECRET", "TOP_SECRET"]`. */
  levels: readonly string[];
  /** The country `NOFORN` data may be released to, as three capital letters. */
  homeCountry: string;
  /** What this system itself may hold. Default: its highest level, and CUI. */
  accreditation?: { level: string; cui: boolean };
  /** Audit name. Default `"security-labels"`. */
  name?: string;
}

const TOKEN = /^[A-Z0-9][A-Z0-9_-]*$/;
const COUNTRY = /^[A-Z]{3}$/;
const RELEASE = /^REL TO ([A-Z]{3}(?:, [A-Z]{3})*)$/;
/** Words a compartment or category may not be: they mean releasability. */
const RESERVED = new Set(["NOFORN", "REL", "CUI"]);
/** Released to no one: an empty `REL TO` can't be written as a list, and this marking parses as nothing, so it is refused. */
const RELEASABLE_TO_NO_ONE = "//REL TO NO ONE";

/** `A/B/…` as a set of tokens, or `undefined` if any isn't one. */
function tokens(segment: string): Set<string> | undefined {
  const parts = segment.split("/");
  return parts.every((t) => TOKEN.test(t) && !RESERVED.has(t)) ? new Set(parts) : undefined;
}

const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every((v) => typeof v === "string");
const stringList = (value: unknown): string[] | undefined => (isStringList(value) ? value : undefined);
const intersect = (a: Set<string> | undefined, b: Set<string> | undefined): Set<string> | undefined =>
  a === undefined ? b : b === undefined ? a : new Set([...a].filter((x) => b.has(x)));

/**
 * A reference multi-dimensional scheme (ADR-0041) — a demonstration of the
 * model, *not* the CAPCO register. A marking is either classified,
 * `LEVEL[//COMPARTMENT/…][//REL TO AAA, BBB | //NOFORN]` — released to the
 * home country alone is written `NOFORN` — or controlled,
 * `CUI[//CATEGORY/…]`: CUI is its own regime of categories, not a level. The
 * join takes the highest level, the union of compartments and of CUI
 * categories, and the intersection of releasability. A subject needs the
 * level (`clearance`), every compartment (`attributes.compartments`), a
 * releasable nationality (`attributes.citizenship`), and every CUI category
 * (`attributes.cuiCategories`); the system itself needs the accreditation.
 */
export function securityLabels(options: SecurityLabelsOptions): ClassificationScheme {
  const levels = [...options.levels];
  const rank = new Map(levels.map((level, i) => [level, i]));
  if (levels.length === 0 || rank.size !== levels.length || levels.includes("CUI")) throw new TypeError("securityLabels() needs distinct levels, none of them CUI");
  if (!COUNTRY.test(options.homeCountry)) throw new TypeError("securityLabels() needs a three-letter homeCountry");
  const accreditation = options.accreditation ?? { level: levels.at(-1)!, cui: true };
  const accredited = rank.get(accreditation.level);
  if (accredited === undefined) throw new TypeError(`securityLabels() accreditation level "${accreditation.level}" is not a level`);

  /** Segment by segment: `LEVEL[//COMPARTMENTS][//RELEASABILITY]`, or `CUI[//CATEGORIES]`. Anything else is `undefined`. */
  function parse(marking: string): Label | undefined {
    const [head, ...rest] = marking.split("//");
    if (head === "CUI") {
      if (rest.length === 0) return { compartments: new Set(), cui: new Set() };
      const categories = rest.length === 1 ? tokens(rest[0]!) : undefined;
      return categories ? { compartments: new Set(), cui: categories } : undefined;
    }
    const level = rank.get(head!);
    if (level === undefined || rest.length > 2) return undefined;
    let releasableTo: Set<string> | undefined;
    const last = rest.at(-1);
    const release = last === "NOFORN" ? new Set([options.homeCountry]) : last === undefined ? undefined : RELEASE.exec(last)?.[1]?.split(", ");
    if (release !== undefined) {
      releasableTo = new Set(release);
      rest.pop();
    }
    if (rest.length > 1) return undefined;
    const compartments = rest.length === 1 ? tokens(rest[0]!) : new Set<string>();
    return compartments ? { level, compartments, ...(releasableTo ? { releasableTo } : {}) } : undefined;
  }

  function combine(labels: readonly Label[]): Label {
    return labels.reduce<Label>(
      (acc, l) => ({
        level: l.level === undefined ? acc.level : acc.level === undefined ? l.level : Math.max(acc.level, l.level),
        compartments: new Set([...acc.compartments, ...l.compartments]),
        releasableTo: intersect(acc.releasableTo, l.releasableTo),
        cui: acc.cui === undefined ? l.cui : l.cui === undefined ? acc.cui : new Set([...acc.cui, ...l.cui])
      }),
      { compartments: new Set() }
    );
  }

  /** A label written back in this grammar: one classified marking if it has a level, one CUI marking if it is CUI. */
  function format(label: Label): string[] {
    const out: string[] = [];
    if (label.level !== undefined) {
      const compartments = [...label.compartments].sort();
      const release = label.releasableTo;
      const releaseText =
        release === undefined ? "" : release.size === 0 ? RELEASABLE_TO_NO_ONE : release.size === 1 && release.has(options.homeCountry) ? "//NOFORN" : `//REL TO ${[...release].sort().join(", ")}`;
      out.push(`${levels[label.level]}${compartments.length ? `//${compartments.join("/")}` : ""}${releaseText}`);
    }
    if (label.cui !== undefined) out.push(`CUI${label.cui.size ? `//${[...label.cui].sort().join("/")}` : ""}`);
    return out;
  }

  return Object.freeze({
    name: options.name ?? "security-labels",
    join(markings: readonly string[]) {
      const parsed = markings.map(parse);
      // A marking it can't parse is kept as it is, so the decision refuses it.
      const unknown = markings.filter((_, i) => parsed[i] === undefined).sort();
      return distinct([...format(combine(parsed.filter((l): l is Label => l !== undefined))), ...unknown]);
    },
    decide({ subject, markings }: ClassificationRequest): ClassificationDecision {
      const parsed = markings.map(parse);
      const bad = markings.find((_, i) => parsed[i] === undefined);
      if (bad !== undefined) return { allow: false, reason: `unrecognized marking ${bad}` };
      const label = combine(parsed as Label[]);
      if (label.level !== undefined) {
        if (label.level > accredited) return { allow: false, reason: `the system is not accredited for ${levels[label.level]}` };
        const held = (subject.clearance === undefined ? undefined : rank.get(subject.clearance)) ?? -1;
        if (held < label.level) return { allow: false, reason: `clearance below ${levels[label.level]}` };
      }
      const compartments = stringList(subject.attributes.compartments) ?? [];
      const missing = [...label.compartments].filter((c) => !compartments.includes(c));
      if (missing.length > 0) return { allow: false, reason: `not read into ${missing.join("/")}` };
      if (label.releasableTo !== undefined) {
        const citizenship = subject.attributes.citizenship;
        if (typeof citizenship !== "string" || !label.releasableTo.has(citizenship)) return { allow: false, reason: "not releasable to this subject" };
      }
      if (label.cui !== undefined) {
        if (!accreditation.cui) return { allow: false, reason: "the system is not accredited for CUI" };
        const categories = stringList(subject.attributes.cuiCategories);
        if (categories === undefined) return { allow: false, reason: "not authorized for CUI" };
        const lacking = [...label.cui].filter((c) => !categories.includes(c));
        if (lacking.length > 0) return { allow: false, reason: `not authorized for CUI//${lacking.join("/")}` };
      }
      return { allow: true };
    }
  });
}

/** A Type's own markings — the classification of every object of it (`x-provenance.defaultClassification`). Empty when unmarked. */
export function objectMarkings(typeDef: TypeDefinition): string[] {
  const marking = typeDef.schema["x-provenance"]?.defaultClassification;
  return marking === undefined ? [] : [marking];
}

/** A member's (property's or relationship's) own markings, `x-provenance.properties[member].classification`. Empty when unmarked. */
export function memberMarkings(typeDef: TypeDefinition, member: string): string[] {
  const properties = typeDef.schema["x-provenance"]?.properties;
  const marking = properties && Object.hasOwn(properties, member) ? properties[member]?.classification : undefined;
  return marking === undefined ? [] : [marking];
}

/** Whether the Type or any of its members carries a marking. */
export function isMarked(typeDef: TypeDefinition): boolean {
  const properties = typeDef.schema["x-provenance"]?.properties ?? {};
  return objectMarkings(typeDef).length > 0 || Object.keys(properties).some((member) => memberMarkings(typeDef, member).length > 0);
}

/** The markings stored values carry in their provenance (`ProvenanceRef.classification`). Empty when none do. */
export function valueMarkings(provenance: readonly ProvenanceRef[]): string[] {
  return provenance.flatMap((p) => (p.classification === undefined ? [] : [p.classification]));
}
