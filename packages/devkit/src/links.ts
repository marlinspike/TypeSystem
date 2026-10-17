import type { Explanation, Identity, ModelInspection, SemanticRuntime } from "@typesys/core";

export const LINKS_FORMAT = "typesys.links/1";

/** What probing links asks of a runtime, each call decided for its caller. */
export type LinksRuntime = Pick<SemanticRuntime, "describeModel" | "query" | "explain"> & Partial<Pick<SemanticRuntime, "canInspect" | "inspectModel">>;

/** One relationship, probed on a few objects (ADR-0094). */
export interface LinkReport {
  readonly type: string;
  readonly relationship: string;
  readonly target: string;
  /**
   * Resolved through a different source than the one the Type's own values
   * come from, with both named. Known only to an inspector.
   */
  readonly crossSource?: { readonly from: string; readonly through: string; readonly target?: string };
  /** Objects of the Type whose relationship was explained. */
  readonly probed: number;
  /**
   * Objects sampled that the subject may not read themselves, so their links
   * say nothing about the subject's: not probed, and counted here.
   */
  readonly unreadable: number;
  /** Related objects returned to the subject, across the objects probed. */
  readonly returned: number;
  /** Objects with nothing related: none returned, and none refused or dangling. */
  readonly empty: number;
  /**
   * References to objects no source holds, and related objects the subject
   * was refused: counted only when an inspector explains another subject's
   * access, since telling a caller either would name what they may not read.
   */
  readonly dangling?: number;
  readonly refused?: number;
  /** Objects whose relationship could not be resolved: a source did not answer. */
  readonly unavailable: number;
  /** Objects whose relationship had more related objects than are read. */
  readonly truncated: number;
  /** Up to three findings that were not `returned`, as the explanation gave them. */
  readonly examples: readonly { readonly object: string; readonly outcome: string; readonly reason?: string }[];
}

export interface LinkProbe {
  readonly format: typeof LINKS_FORMAT;
  /** Whose access was probed. */
  readonly subject: string;
  readonly investigator: string;
  readonly disclosure: Explanation["disclosure"];
  readonly relationships: readonly LinkReport[];
  readonly caveat: string;
}

export interface LinkOptions {
  /** Explain this subject's access, which needs the inspection policy. Default: the investigator's own. */
  readonly as?: Identity;
  /** Only these Types. */
  readonly types?: readonly string[];
  /** Objects of each Type to probe. Default 3. Explaining another subject, up to ten times as many are tried to find this many the subject may read. */
  readonly sample?: number;
  /** Only relationships resolved through another source. Needs an inspection; ignored without one. */
  readonly crossSourceOnly?: boolean;
}

export const LINKS_CAVEAT = "Counts are for the objects probed, as the runtime decides them now. A reference that resolves on these objects may dangle on another.";

/**
 * Probes each relationship of each Type on a few objects (ADR-0094): how
 * many related objects are returned, and, for an inspector explaining
 * someone, how many references dangle or are refused. Each relationship is
 * explained through the runtime (ADR-0089), so nothing is read that the
 * runtime would not decide, and nothing is copied.
 */
export async function probeLinks(runtime: LinksRuntime, investigator: Identity, opts: LinkOptions = {}): Promise<LinkProbe> {
  const model = await runtime.describeModel(investigator);
  const inspection: ModelInspection | undefined = runtime.canInspect && runtime.inspectModel && (await runtime.canInspect(investigator)) ? await runtime.inspectModel(investigator) : undefined;
  const wanted = opts.types ? new Set(opts.types) : undefined;
  const reports: LinkReport[] = [];
  let disclosure: Explanation["disclosure"] = inspection ? "inspector" : "caller";
  for (const t of model.types) {
    if (wanted && !wanted.has(t.name)) continue;
    const inspected = inspection?.types.find((x) => x.name === t.name);
    let ids: string[] | undefined;
    for (const r of t.relationships) {
      const ri = inspected?.relationships.find((x) => x.name === r.name);
      const own = inspected?.source?.dataSourceId;
      const targetSource = inspection?.types.find((x) => x.name === r.target)?.source?.dataSourceId;
      // Across systems when it is resolved through another source, or when what it names lives in one (a code on a shipment naming a site the inventory holds).
      const crossing = ri !== undefined && own !== undefined && (ri.crossSource || (targetSource !== undefined && targetSource !== own));
      if (opts.crossSourceOnly && inspection && !crossing) continue;
      const sample = opts.sample ?? 3;
      try {
        ids ??= (await runtime.query({ type: t.name, limit: opts.as ? sample * 10 : sample }, investigator)).items.map((o) => o.objectId);
      } catch {
        ids = [];
      }
      const report = { probed: 0, unreadable: 0, returned: 0, empty: 0, dangling: 0, refused: 0, unavailable: 0, truncated: 0, examples: [] as { object: string; outcome: string; reason?: string }[] };
      for (const id of ids) {
        if (report.probed >= sample) break;
        let e: Explanation;
        try {
          e = await runtime.explain({ kind: "relationship", type: t.name, id, relationship: r.name }, investigator, opts.as ? { as: opts.as } : {});
        } catch (err) {
          // Refused to the investigator, as their own question would be: the probe stops here, and says so.
          if (report.examples.length < 3) report.examples.push({ object: `${t.name}/${id}`, outcome: "refused", reason: err instanceof Error ? err.message : String(err) });
          continue;
        }
        disclosure = e.disclosure;
        // The subject may not read this object at all: its links are not theirs to follow, so it is not a probe of them.
        if (e.outcome === "refused" && e.findings.some((f) => f.about === `${t.name}/${id}` && f.outcome === "refused")) {
          report.unreadable++;
          continue;
        }
        report.probed++;
        const count = e.findings.find((f) => f.outcome === "returned" && f.member === r.name)?.count ?? 0;
        report.returned += count;
        // Empty means nothing is related, not that everything related was refused or dangles.
        if (e.outcome !== "unavailable" && count === 0 && !e.findings.some((f) => f.outcome === "refused" || f.outcome === "dangling")) report.empty++;
        if (e.outcome === "unavailable") report.unavailable++;
        for (const f of e.findings) {
          if (f.outcome === "dangling") report.dangling++;
          else if (f.outcome === "refused") report.refused++;
          else if (f.outcome === "truncated") report.truncated++;
          if (f.outcome !== "returned" && report.examples.length < 3) report.examples.push({ object: f.about, outcome: f.outcome, ...(f.reason ? { reason: f.reason } : {}) });
        }
      }
      const told = disclosure === "inspector" && opts.as !== undefined && opts.as.subjectId !== investigator.subjectId;
      reports.push({
        type: t.name,
        relationship: r.name,
        target: r.target,
        ...(crossing ? { crossSource: { from: own, through: ri.source.dataSourceId, ...(targetSource ? { target: targetSource } : {}) } } : {}),
        probed: report.probed,
        unreadable: report.unreadable,
        returned: report.returned,
        empty: report.empty,
        ...(told ? { dangling: report.dangling, refused: report.refused } : {}),
        unavailable: report.unavailable,
        truncated: report.truncated,
        examples: report.examples
      });
    }
  }
  return { format: LINKS_FORMAT, subject: opts.as?.subjectId ?? investigator.subjectId, investigator: investigator.subjectId, disclosure, relationships: reports, caveat: LINKS_CAVEAT };
}

/** The probe as lines for a terminal. */
export function renderLinks(probe: LinkProbe): string[] {
  return [
    `Links as ${probe.subject}${probe.subject !== probe.investigator ? `, explained to ${probe.investigator}` : ""}:`,
    ...probe.relationships.map((r) => {
      const where = r.crossSource ? ` [${r.crossSource.from} → ${r.crossSource.target ?? r.crossSource.through}]` : "";
      const counts = [`${r.probed} probed`, ...(r.unreadable ? [`${r.unreadable} not readable by ${probe.subject}`] : []), `${r.returned} returned`, ...(r.empty ? [`${r.empty} empty`] : []), ...(r.dangling !== undefined ? [`${r.dangling} dangling`, `${r.refused ?? 0} refused`] : []), ...(r.unavailable ? [`${r.unavailable} unavailable`] : []), ...(r.truncated ? [`${r.truncated} truncated`] : [])];
      return `  ${`${r.type}.${r.relationship} → ${r.target}`.padEnd(56)}${where} ${counts.join(", ")}`;
    }),
    ...(probe.relationships.some((r) => r.dangling === undefined) ? ["Dangling and refused references are counted only when an inspector explains another caller's access (--for)."] : []),
    probe.caveat
  ];
}
