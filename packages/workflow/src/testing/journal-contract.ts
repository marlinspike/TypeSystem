import { JournalConflictError } from "../errors.js";
import type { JournalEvent, WorkflowJournal } from "../journal.js";

/**
 * The contract every `WorkflowJournal` must pass identically (ADR-0057,
 * ADR-0065). Like core's registry-store contract it takes the test
 * framework's functions as parameters, so this package never depends on one.
 * `make` returns a journal with no runs in it.
 */
export interface JournalContractHarness {
  describe: (name: string, fn: () => void) => void;
  it: (name: string, fn: () => Promise<void>) => void;
  expect: (value: unknown) => {
    toEqual(expected: unknown): void;
    toBe(expected: unknown): void;
    toHaveLength(length: number): void;
    toBeInstanceOf(c: unknown): void;
  };
}

const started = (initiator = "u1"): JournalEvent => ({
  type: "run-started",
  workflow: "test.Flow",
  version: "1.0.0",
  initiator: { subjectId: initiator, roles: ["r"], attributes: { name: "Zoë", nested: { list: [1, "two", null, true] } }, expiresAt: "2026-10-14T12:00:00.000Z" },
  input: { a: 1, unicode: "ünïcødé ✓", empty: {}, list: [] }
});
const AT = "2026-10-14T12:00:00.000Z";
let counter = 0;
const newRun = () => `run-${Date.now()}-${counter++}-${Math.random().toString(36).slice(2)}`;

export function workflowJournalContract(name: string, make: () => Promise<WorkflowJournal>, t: JournalContractHarness): void {
  const { describe, it, expect } = t;
  describe(`WorkflowJournal contract: ${name}`, () => {
    it("an unknown run reads as empty", async () => {
      expect(await (await make()).read(newRun())).toEqual([]);
    });

    it("appends in order, numbering from 0, and reads back exactly what was written", async () => {
      const j = await make();
      const run = newRun();
      await j.append(run, 0, [started()], AT);
      await j.append(run, 1, [{ type: "step-started", step: "s", attempt: 1, input: { x: [1, { y: "z" }] } }, { type: "step-completed", step: "s", attempt: 1, output: { ok: true, n: 1.5 }, source: "compute" }], AT);
      const records = await j.read(run);
      expect(records.map((r) => [r.seq, r.type, r.at])).toEqual([
        [0, "run-started", AT],
        [1, "step-started", AT],
        [2, "step-completed", AT]
      ]);
      expect(records[0]).toEqual({ ...started(), seq: 0, at: AT });
      expect(records[2]).toEqual({ type: "step-completed", step: "s", attempt: 1, output: { ok: true, n: 1.5 }, source: "compute", seq: 2, at: AT });
    });

    it("refuses an append at the wrong length, and writes none of it", async () => {
      const j = await make();
      const run = newRun();
      await j.append(run, 0, [started()], AT);
      let thrown: unknown;
      try {
        await j.append(run, 0, [{ type: "step-skipped", step: "a" }, { type: "step-skipped", step: "b" }], AT);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(JournalConflictError);
      expect((thrown as JournalConflictError).actual).toBe(1);
      expect(await j.read(run)).toHaveLength(1);
      // A gap is refused too.
      await j.append(run, 5, [{ type: "step-skipped", step: "a" }], AT).then(
        () => expect("appended past the end").toBe("refused"),
        (err: unknown) => expect(err).toBeInstanceOf(JournalConflictError)
      );
    });

    it("of many writers appending at one length at once, exactly one succeeds", async () => {
      const j = await make();
      const run = newRun();
      await j.append(run, 0, [started()], AT);
      const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => j.append(run, 1, [{ type: "step-skipped", step: `w${i}` }, { type: "step-skipped", step: `x${i}` }], AT)));
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((r) => r.status === "rejected").every((r) => (r).reason instanceof JournalConflictError)).toBe(true);
      const records = await j.read(run);
      expect(records).toHaveLength(3);
      // The winner's two events, together.
      expect((records[1] as { step: string }).step.slice(1)).toBe((records[2] as { step: string }).step.slice(1));
    });

    it("of many writers starting one run at once, exactly one succeeds", async () => {
      const j = await make();
      const run = newRun();
      const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => j.append(run, 0, [started(`u${i}`)], AT)));
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(await j.read(run)).toHaveLength(1);
    });

    it("lists its runs, and those not finished", async () => {
      const j = await make();
      const [open, done] = [newRun(), newRun()];
      await j.append(open, 0, [started()], AT);
      await j.append(done, 0, [started()], AT);
      await j.append(done, 1, [{ type: "run-finished", status: "completed" }], AT);
      const runs = await j.runs();
      expect([open, done].every((r) => runs.includes(r))).toBe(true);
      if (j.unfinished) {
        const unfinished = await j.unfinished();
        expect(unfinished.includes(open)).toBe(true);
        expect(unfinished.includes(done)).toBe(false);
      }
    });

    it("stores any string an Action may return, NUL and the escape characters included", async () => {
      const j = await make();
      const run = newRun();
      const output = { nul: "before\u0000after", escaped: "\\u0000 is not NUL", wrapperLike: { "$typesys-json": "{}" } };
      await j.append(run, 0, [started(), { type: "step-completed", step: "s", attempt: 1, output, source: "compute" }], AT);
      expect((await j.read(run))[1]).toEqual({ type: "step-completed", step: "s", attempt: 1, output, source: "compute", seq: 1, at: AT });
    });

    it("hands out copies: changing what was read changes nothing stored", async () => {
      const j = await make();
      const run = newRun();
      await j.append(run, 0, [started()], AT);
      const first = await j.read(run);
      (first[0] as { input: { a: number } }).input.a = 99;
      expect(((await j.read(run))[0] as { input: { a: number } }).input.a).toBe(1);
    });
  });
}
