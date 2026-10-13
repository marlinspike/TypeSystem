/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- each @ts-expect-error line deliberately calls what the model does not offer */
import { describe, it, expect, expectTypeOf } from "vitest";
import type { ActionPreview, ProvenanceRef } from "@typesys/core";
import type { AirforceModel } from "@typesys/domain-airforce";
import type { HospitalModel } from "@typesys/domain-hospital";
import { and, createClient, fields, or, type Transport } from "../src/index.js";

/**
 * What the model lets a caller write (ADR-0055). The assertions are checked by
 * `npm run typecheck`; each `@ts-expect-error` fails it if the line it marks
 * ever compiles. Vitest runs the file too, so the queries built here are
 * also checked for the SemanticQuery they stand for.
 */
const unreachable = (): never => {
  throw new Error("type-level test: no transport");
};
const offline: Transport = {
  query: unreachable,
  explain: unreachable,
  getObject: unreachable,
  getRelationship: unreachable,
  getProvenance: unreachable,
  listActions: unreachable,
  previewAction: unreachable,
  invokeAction: unreachable
};
const af = createClient<AirforceModel>(offline);
const hospital = createClient<HospitalModel>(offline);

type RowOf<P> = P extends Promise<{ items: (infer R)[] }> ? R : never;

describe("the typed model (ADR-0055)", () => {
  it("types every value optional, computed ones by their declared schema", () => {
    const _q = af.from("airforce.Aircraft");
    type Row = RowOf<ReturnType<typeof _q.page>>;
    expectTypeOf<Row["$id"]>().toEqualTypeOf<string>();
    expectTypeOf<Row["$type"]>().toEqualTypeOf<"airforce.Aircraft">();
    expectTypeOf<Row["tailNumber"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<Row["readinessStatus"]>().toEqualTypeOf<"FMC" | "PMC" | "NMC" | "UNKNOWN" | undefined>();
    expectTypeOf<Row["needsAttention"]>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<Row["maintenanceStatus"]>().toEqualTypeOf<"operational" | "degraded" | "down" | undefined>();
  });

  it("narrows rows to a selection and adds typed includes", () => {
    const _q = af
      .from("airforce.Aircraft")
      .select("tailNumber", "needsAttention")
      .include("components", (c) => c.select("condition"))
      .include("maintenance", (m) => m.include("workOrder", (w) => w.select("status")))
      .withProvenance();
    type Row = RowOf<ReturnType<typeof _q.page>>;
    expectTypeOf<keyof Row>().toEqualTypeOf<"$id" | "$type" | "tailNumber" | "needsAttention" | "components" | "maintenance" | "$provenance">();
    expectTypeOf<Row["components"][number]["condition"]>().toEqualTypeOf<"good" | "fair" | "poor" | undefined>();
    expectTypeOf<Row["components"][number]["$type"]>().toEqualTypeOf<"airforce.Component">();
    expectTypeOf<Row["maintenance"][number]["workOrder"][number]["status"]>().toEqualTypeOf<"open" | "in-progress" | "closed" | undefined>();
    expectTypeOf<Row["$provenance"]>().toEqualTypeOf<readonly ProvenanceRef[]>();
  });

  it("refuses names and operators the model does not have", () => {
    // @ts-expect-error not a Type
    af.from("airforce.Ship");
    // @ts-expect-error not a property of Aircraft
    af.from("airforce.Aircraft").select("hullNumber");
    // @ts-expect-error not a relationship of Aircraft
    af.from("airforce.Aircraft").include("crew");
    // @ts-expect-error a computed property cannot be a top-level sort: the source system sorts (ADR-0054)
    af.from("airforce.Aircraft").orderBy("readinessStatus");
    // ...but an include's sort runs after resolution, so it may
    af.from("airforce.MaintenanceEvent").include("workOrder", (w) => w.orderBy("status"));
    // @ts-expect-error not one of readinessStatus's values
    af.from("airforce.Aircraft").where((a) => a.readinessStatus.eq("GREEN"));
    // @ts-expect-error the runtime orders only numbers (matchesFilter), so a string property has no gt
    af.from("airforce.Aircraft").where((a) => a.tailNumber.gt(5));
    // @ts-expect-error icontains applies to strings only
    af.from("airforce.Aircraft").where((a) => a.needsAttention.icontains("t"));
    // @ts-expect-error the wrong type for the equality shorthand
    af.from("airforce.Aircraft").where({ needsAttention: "yes" });
    // @ts-expect-error a filter built for one Type cannot filter another
    af.from("airforce.Component").where(fields<AirforceModel, "airforce.Aircraft">().needsAttention.eq(true));
    // @ts-expect-error a Type of the other model
    af.from("hospital.Patient");
    expect(hospital.from("hospital.Patient").select("displayName").toQuery()).toEqual({ type: "hospital.Patient", select: ["displayName"] });
  });

  it("types Actions by their declared input and output", () => {
    const update = af.action("UpdateWorkOrderStatus");
    expectTypeOf(update.invoke).parameter(0).toEqualTypeOf<{ workOrderId: string; status: "open" | "in-progress" | "closed" }>();
    expectTypeOf(update.preview).returns.toEqualTypeOf<Promise<ActionPreview>>();
    expectTypeOf(af.action("CreateMaintenanceWorkOrder").invoke).returns.resolves.toHaveProperty("id");
    // @ts-expect-error not an Action
    af.action("DeleteAircraft");
    // Typed, never called: this client has no transport.
    const _wrongStatus = () =>
      // @ts-expect-error status must be one the schema allows
      af.action("UpdateWorkOrderStatus").preview({ workOrderId: "WO-1", status: "done" });
    type Listed = Awaited<ReturnType<typeof af.actions<"airforce.WorkOrder">>>[number]["name"];
    expectTypeOf<Listed>().toEqualTypeOf<"UpdateWorkOrderStatus">();
  });

  it("composes reusable filters into the conjunction the runtime splits best", () => {
    const a = fields<AirforceModel, "airforce.Aircraft">();
    const flagged = or(a.needsAttention.eq(true), a.readinessStatus.in(["NMC", "PMC"]));
    const q = af.from("airforce.Aircraft").where(and(a.model.eq("F-16C"), flagged)).where({ tailNumber: "AF86-0147" }).toQuery();
    expect(q.filter).toEqual({
      and: [
        { property: "model", operator: "eq", value: "F-16C" },
        { or: [{ property: "needsAttention", operator: "eq", value: true }, { property: "readinessStatus", operator: "in", value: ["NMC", "PMC"] }] },
        { property: "tailNumber", operator: "eq", value: "AF86-0147" }
      ]
    });
  });

  it("returns a fresh copy from toQuery, so a caller cannot reach into a built query", () => {
    const q = af.from("airforce.Aircraft").where({ model: "F-16C" });
    const json = q.toQuery();
    (json.filter as { value: string }).value = "tampered";
    expect(q.toQuery().filter).toEqual({ property: "model", operator: "eq", value: "F-16C" });
  });
});
