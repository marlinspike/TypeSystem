// Written once by `typesys app compile` (ADR-0082). This file is yours: the compiler never writes it again.
// The types it must satisfy are in src/generated/contracts.ts.
import type { RecallAffected, RecallInTransit } from "../generated/contracts.js";

/**
 * An NDC as eleven digits, 5-4-2, the way the exchange writes it. The
 * inventory writes it hyphenated; a ten-digit code (4-4-2, 5-3-2 or 5-4-1)
 * is padded in the segment that is short, as the HIPAA eleven-digit form
 * does. Anything else is returned as it came, so it never equals a real one.
 */
export function ndc11(code: string): string {
  const parts = code.split("-");
  if (parts.length !== 3 || !parts.every((p) => /^\d+$/.test(p))) return code.replace(/-/g, "");
  const [a, b, c] = parts as [string, string, string];
  return `${a.padStart(5, "0")}${b.padStart(4, "0")}${c.padStart(2, "0")}`;
}

/**
 * Our affected lots: every lot the notice lists that the inventory holds and
 * has not destroyed, the doses in them and the shipments carrying them. A
 * listed lot we hold under another NDC is `mismatched`: the notice does not
 * describe our stock. Unknown (a source down, a value withheld) when any of
 * it cannot be decided, so the run cannot go on with a partial answer.
 */
export const affected: RecallAffected = ({ listed, ndc, lots }) => {
  if (!listed || !ndc || !lots) return undefined;
  const onNotice = new Set(listed.map((l) => l.lotCode));
  const ours = lots.filter((l) => onNotice.has(l.$id));
  if (ours.some((l) => l.ndc === undefined || l.status === undefined || l.doses === undefined)) return undefined;
  const mismatched = ours.filter((l) => ndc11(l.ndc!) !== ndc).map((l) => l.$id);
  const held = ours.filter((l) => l.status !== "destroyed");
  return {
    lots: held.map((l) => l.$id).sort(),
    doses: held.reduce((sum, l) => sum + l.doses!, 0),
    shipments: [...new Set(held.flatMap((l) => (l.shipmentId ? [l.shipmentId] : [])))].sort(),
    mismatched
  };
};

/** The shipments the tracker shows in transit: a delivered or held one is not, whatever the inventory says of its lots. */
export const inTransit: RecallInTransit = ({ shipments }) => {
  if (!shipments || shipments.some((s) => s.status === undefined)) return undefined;
  return shipments.filter((s) => s.status === "in-transit").map((s) => s.$id);
};
