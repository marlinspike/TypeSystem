import type { GaugeStabilityGauge } from "../generated/contracts.js";

/**
 * How much of the stability budget an excursion spent: a bar, the minutes,
 * and a plain verdict. Unknown while either figure is loading or withheld,
 * and said so rather than drawn as zero.
 */
export const StabilityGauge: GaugeStabilityGauge = ({ minutesOut, budgetMinutes }) => {
  if (minutesOut === undefined || budgetMinutes === undefined) return <p className="ts-muted">Not known yet.</p>;
  const spent = budgetMinutes === 0 ? 1 : Math.min(1, minutesOut / budgetMinutes);
  const tone = spent >= 1 ? "var(--ts-bad)" : spent >= 0.5 ? "var(--ts-warn)" : "var(--ts-good)";
  const verdict = budgetMinutes === 0 ? "No budget at this peak: the product may not be used." : spent >= 1 ? "Budget spent: the lots should not be released." : `${budgetMinutes - minutesOut} minutes of budget left.`;
  return (
    <div data-gauge={Math.round(spent * 100)}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <strong style={{ fontSize: 32, fontFamily: "var(--ts-font-display)" }}>{Math.round(spent * 100)}%</strong>
        <span className="ts-muted">
          {minutesOut} of {budgetMinutes} min
        </span>
      </div>
      <div role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(spent * 100)} aria-label="Stability budget spent" style={{ height: 10, borderRadius: 5, background: "var(--ts-surface-2, rgba(127,127,127,0.2))", margin: "12px 0", overflow: "hidden" }}>
        <div style={{ width: `${spent * 100}%`, height: "100%", background: tone }} />
      </div>
      <p style={{ margin: 0 }}>{verdict}</p>
    </div>
  );
};
