import { describe, it, expect } from "vitest";
import { mapWithConcurrency, mapWithConcurrencySettled } from "../src/runtime/concurrency.js";

describe("mapWithConcurrency", () => {
  it("preserves input order regardless of completion order", async () => {
    const delays = [30, 10, 20, 5];
    const results = await mapWithConcurrency(delays, 4, async (ms, i) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return i;
    });
    expect(results).toEqual([0, 1, 2, 3]);
  });

  it("never runs more than `limit` callbacks at once", async () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    let inFlight = 0;
    let maxConcurrent = 0;

    await mapWithConcurrency(items, 3, async (i) => {
      inFlight++;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return i;
    });

    expect(maxConcurrent).toBeLessThanOrEqual(3);
    expect(maxConcurrent).toBeGreaterThan(1); // still genuinely concurrent, not accidentally serialized
  });

  it("returns [] for an empty input without calling fn", async () => {
    let called = false;
    const result = await mapWithConcurrency([], 5, async () => {
      called = true;
      return 1;
    });
    expect(result).toEqual([]);
    expect(called).toBe(false);
  });

  it("propagates a rejection", async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (i) => {
        if (i === 2) throw new Error("boom");
        return i;
      })
    ).rejects.toThrow("boom");
  });

  it("tolerates a limit larger than the item count", async () => {
    const result = await mapWithConcurrency([1, 2], 50, async (i) => i * 2);
    expect(result).toEqual([2, 4]);
  });
});

describe("mapWithConcurrencySettled", () => {
  it("never rejects — collects fulfilled and rejected outcomes, preserving order", async () => {
    const results = await mapWithConcurrencySettled([1, 2, 3], 2, async (i) => {
      if (i === 2) throw new Error("item 2 failed");
      return i * 10;
    });

    expect(results[0]).toEqual({ status: "fulfilled", value: 10 });
    expect(results[1]?.status).toBe("rejected");
    expect((results[1] as PromiseRejectedResult).reason.message).toBe("item 2 failed");
    expect(results[2]).toEqual({ status: "fulfilled", value: 30 });
  });
});
