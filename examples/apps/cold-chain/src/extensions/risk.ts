import type { RiskValueAtRisk } from "../generated/contracts.js";

/**
 * What the lots on affected shipments are worth at contract price. Unknown,
 * never a smaller number, when any lot's price is withheld from the caller
 * or its dose count is unknown: a partial sum would understate the risk.
 */
export const valueAtRisk: RiskValueAtRisk = ({ lots }) => {
  if (lots === undefined) return undefined;
  let total = 0;
  for (const lot of lots) {
    if (lot.unitCost === undefined || lot.doses === undefined) return undefined;
    total += lot.unitCost * lot.doses;
  }
  return Math.round(total);
};
