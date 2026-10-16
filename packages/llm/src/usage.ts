import type { CallRecord } from "./types.js";

export interface UsageTotals {
  calls: number;
  failures: number;
  /** Calls refused before anything was sent (capability, release, configuration). */
  refusals: number;
  inputTokens: number;
  outputTokens: number;
  /** Calls whose usage was estimated because the provider reported none. */
  estimatedCalls: number;
  /** Total configured cost; calls to a model with no configured price add nothing and are counted in `unpriced`. */
  costUsd: number;
  unpriced: number;
  latencyMs: number;
}

const zero = (): UsageTotals => ({ calls: 0, failures: 0, refusals: 0, inputTokens: 0, outputTokens: 0, estimatedCalls: 0, costUsd: 0, unpriced: 0, latencyMs: 0 });

/** Token, latency and cost accounting across every call an `Llm` makes, in all, by model and by purpose (ADR-0074). */
export class UsageMeter {
  private readonly all = zero();
  private readonly models = new Map<string, UsageTotals>();
  private readonly purposes = new Map<string, UsageTotals>();
  private readonly log: CallRecord[] = [];

  record(r: CallRecord): void {
    this.log.push(r);
    const into = [this.all, at(this.models, r.model.id), at(this.purposes, r.purpose ?? "(none)")];
    for (const t of into) {
      t.calls++;
      if (r.error) {
        t.failures++;
        if (r.attempts === 0) t.refusals++;
      }
      if (r.usage) {
        t.inputTokens += r.usage.inputTokens;
        t.outputTokens += r.usage.outputTokens;
        if (r.usage.estimated) t.estimatedCalls++;
        if (r.cost) t.costUsd = Math.round((t.costUsd + r.cost.amount) * 1e8) / 1e8;
        else t.unpriced++;
      }
      t.latencyMs += r.latencyMs;
    }
  }

  totals(): Readonly<UsageTotals> {
    return { ...this.all };
  }

  byModel(): Record<string, UsageTotals> {
    return Object.fromEntries([...this.models].map(([k, v]) => [k, { ...v }]));
  }

  byPurpose(): Record<string, UsageTotals> {
    return Object.fromEntries([...this.purposes].map(([k, v]) => [k, { ...v }]));
  }

  /** Every record so far, oldest first. */
  records(): readonly CallRecord[] {
    return [...this.log];
  }
}

function at(map: Map<string, UsageTotals>, key: string): UsageTotals {
  let t = map.get(key);
  if (!t) map.set(key, (t = zero()));
  return t;
}
