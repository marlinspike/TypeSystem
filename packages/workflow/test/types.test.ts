/* eslint-disable @typescript-eslint/no-unsafe-return -- each @ts-expect-error line deliberately uses what the model does not offer */
import { describe, it, expect, expectTypeOf } from "vitest";
import type { AirforceModel } from "@typesys/domain-airforce";
import { defineWorkflow, type Step } from "../src/index.js";

/**
 * What a typed workflow lets its author write (ADR-0057), checked by
 * `npm run typecheck`: each `@ts-expect-error` fails it if the line it marks
 * ever compiles.
 */
type In = { aircraftId: string };
type S = Step<AirforceModel, In>;

const base = { name: "airforce.TypeCheck", version: "1.0.0", startPolicy: "p", inputSchema: { type: "object" } } as const;

describe("typed workflow definitions", () => {
  it("types Action inputs, compensations and reads by the model", () => {
    const w = defineWorkflow<AirforceModel, In>({
      ...base,
      steps: [
        { kind: "read", name: "a", run: (af, ctx) => af.get("airforce.Aircraft", ctx.input.aircraftId) },
        {
          kind: "action",
          name: "open",
          action: "CreateMaintenanceWorkOrder",
          input: () => ({ maintenanceEventId: "E", assignedTo: "x" }),
          compensate: {
            action: "UpdateWorkOrderStatus",
            input: (_ctx, output) => {
              expectTypeOf(output.id).toEqualTypeOf<string | undefined>();
              return { workOrderId: output.id ?? "", status: "closed" };
            }
          }
        }
      ]
    });
    expect(w.steps).toHaveLength(2);

    // @ts-expect-error -- not an Action of the model
    const _unknown: S = { kind: "action", name: "x", action: "LaunchAircraft", input: () => ({}) };
    // @ts-expect-error -- the input lacks assignedTo
    const _missing: S = { kind: "action", name: "x", action: "CreateMaintenanceWorkOrder", input: () => ({ maintenanceEventId: "E" }) };
    // @ts-expect-error -- not a status the Action accepts
    const _status: S = { kind: "action", name: "x", action: "UpdateWorkOrderStatus", input: () => ({ workOrderId: "W", status: "scrapped" }) };
    // @ts-expect-error -- not a Type of the model
    const _read: S = { kind: "read", name: "x", run: (af) => af.get("airforce.Aircrft", "x") };
    // @ts-expect-error -- the run's input has no such field
    const _input: S = { kind: "compute", name: "x", run: (ctx) => ctx.input.tailNumber };
  });
});
