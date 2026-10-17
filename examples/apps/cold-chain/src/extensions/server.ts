import { scriptedAdapter, type LlmOptions } from "@typesys/llm";

/**
 * The quality enclave's model, for tests and the demonstration: a
 * deterministic stand-in that applies the stability rule to what it is sent,
 * so a run reaches its sign-off without a model server. A deployment points
 * the `qa-enclave` provider in typesys.llm.json at its own model and returns
 * {} here. Nothing about it is special to the compiler: it is an ordinary
 * `llmOptions()`. With TYPESYS_LLM_CONFIG naming another configuration
 * (examples/apps/cold-chain/llm/), the stand-in is not used at all.
 */
export async function llmOptions(): Promise<LlmOptions> {
  if (process.env.TYPESYS_LLM_CONFIG) return {};
  return {
    adapters: {
      "qa-enclave": scriptedAdapter((request) => {
        const text = JSON.stringify(request.messages);
        const num = (name: string) => Number(new RegExp(`\\\\?"${name}\\\\?":(-?[0-9.]+)`).exec(text)?.[1]);
        const peak = num("peakC");
        const minutes = num("minutesOut");
        const budget = num("budgetMinutes");
        if (!(Number.isFinite(peak) && Number.isFinite(minutes) && Number.isFinite(budget))) {
          return { json: { disposition: "quarantine", confidence: "low", rationale: "The excursion's figures were not all available, so the lots are held until a pharmacist reviews them." } };
        }
        if (peak < 0) return { json: { disposition: "destroy", confidence: "high", rationale: `The logger read ${peak} °C: the product froze, and no stability data supports using a frozen vaccine.` } };
        if (minutes >= budget) return { json: { disposition: "quarantine", confidence: "medium", rationale: `${minutes} minutes outside 2–8 °C at a peak of ${peak} °C spends the ${budget}-minute stability budget; hold the lots for the manufacturer's assessment.` } };
        return { json: { disposition: "release", confidence: "high", rationale: `${minutes} minutes at a peak of ${peak} °C is within the ${budget}-minute stability budget.` } };
      })
    }
  };
}
