import type { StabilityBudgetMinutes } from "../generated/contracts.js";

/**
 * The team's stability rule for 2–8 °C biologics: how many cumulative
 * minutes outside the range the products tolerate at a given peak. Any
 * freezing reading spends the whole budget, since a frozen vaccine cannot be
 * shown to have survived. The figures are the distributor's own stability
 * data summarized, not a manufacturer's: a deployment replaces them with its
 * products' labelled excursion allowances.
 */
export const budgetMinutes: StabilityBudgetMinutes = ({ peakC }) => {
  if (peakC === undefined) return undefined;
  if (peakC < 0) return 0;
  if (peakC < 2) return 30;
  if (peakC <= 9) return 120;
  if (peakC <= 12) return 60;
  if (peakC <= 15) return 20;
  return 0;
};
