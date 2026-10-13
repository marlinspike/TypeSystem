import { describe, it, expect, beforeAll } from "vitest";
import { createElement, useState, type ReactElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describeModel, type ModelDescription } from "@typesys/core";
import { buildAirforceTestbed, demoIdentities, type AirforceModel, type AirforceTestbed } from "@typesys/domain-airforce";
import { createClient, runtimeTransport } from "@typesys/sdk";
import { Resource, coerceForm, columnsFor, createTypeSHooks, formFields, type ResourceState } from "../src/index.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { TypeSProvider, useQuery, useObject, useAction, useActions } = createTypeSHooks<AirforceModel>();

let testbed: AirforceTestbed;
let model: ModelDescription;
beforeAll(async () => {
  testbed = await buildAirforceTestbed({ mockRestLatencyMs: 0 });
  model = await describeModel(testbed.registry);
});

const clientFor = (who: keyof typeof demoIdentities) => createClient<AirforceModel>(runtimeTransport(testbed.runtime, demoIdentities[who]));

/** Renders `probe` inside a provider for `who`, keeping the latest value it reports. */
async function mount<T>(who: keyof typeof demoIdentities, useProbe: () => T): Promise<{ latest: () => T; renderer: ReactTestRenderer }> {
  let latest: T | undefined;
  function Probe(): null {
    latest = useProbe();
    return null;
  }
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(TypeSProvider, { client: clientFor(who) }, createElement(Probe)) as ReactElement);
  });
  return { latest: () => latest as T, renderer };
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await act(() => new Promise((r) => setTimeout(r, 2)));
  expect(check()).toBe(true);
}

describe("Resource", () => {
  it("settles only the latest run, so a slow earlier answer never overwrites a newer one", async () => {
    const r = new Resource<string>();
    const seen: ResourceState<string>["status"][] = [];
    r.subscribe(() => seen.push(r.getSnapshot().status));
    let releaseSlow!: (v: string) => void;
    const slow = r.run(() => new Promise<string>((res) => (releaseSlow = res)));
    await r.run(async () => "new");
    releaseSlow("old");
    await slow;
    expect(r.getSnapshot()).toEqual({ status: "success", data: "new" });
    expect(seen).toEqual(["loading", "loading", "success"]);
  });

  it("keeps the last data while reloading and on error, and reset abandons a run in flight", async () => {
    const r = new Resource<number>();
    await r.run(async () => 1);
    const reloading = r.run(() => Promise.reject(new Error("down")));
    expect(r.getSnapshot()).toEqual({ status: "loading", data: 1 });
    await reloading;
    expect(r.getSnapshot()).toMatchObject({ status: "error", data: 1, error: { message: "down" } });
    const abandoned = r.run(async () => 2);
    r.reset();
    await abandoned;
    expect(r.getSnapshot()).toEqual({ status: "idle" });
  });
});

describe("the TypeS hooks (ADR-0058)", () => {
  it("useQuery loads a page, appends the next on loadMore, and shows each caller what the runtime gives them", async () => {
    const probe = () => useQuery((c) => c.from("airforce.Aircraft").select("tailNumber", "deploymentLocation").orderBy("tailNumber").limit(1), []);
    const maintainer = await mount("maintainer", probe);
    await until(() => maintainer.latest().status === "success");
    const first = maintainer.latest();
    expect(first.status === "success" && first.data.items.map((r) => r.tailNumber)).toEqual(["AF86-0147"]);
    expect(first.status === "success" && first.data.nextCursor).toBeTruthy();
    act(() => maintainer.latest().loadMore());
    await until(() => {
      const s = maintainer.latest();
      return s.status === "success" && s.data.items.length === 2;
    });
    const both = maintainer.latest();
    expect(both.status === "success" && both.data.items.map((r) => r.tailNumber)).toEqual(["AF86-0147", "AF86-0212"]);
    expect(both.status === "success" && both.data.items.every((r) => typeof r.deploymentLocation === "string")).toBe(true);

    // The same component for a viewer cleared CUI: the SECRET location is withheld by the runtime, not the hook.
    const viewer = await mount("viewer", probe);
    await until(() => viewer.latest().status === "success");
    const seen = viewer.latest();
    expect(seen.status === "success" && seen.data.items[0]).toEqual({ $id: "AF86-0147", $type: "airforce.Aircraft", tailNumber: "AF86-0147" });
  });

  it("useObject reloads when its id changes, and reports a refusal as an error", async () => {
    let setId!: (id: string) => void;
    const view = await mount("maintainer", () => {
      const [id, set] = useState("AF86-0147");
      setId = set;
      return useObject("airforce.Aircraft", id);
    });
    await until(() => view.latest().status === "success");
    const a = view.latest();
    expect(a.status === "success" && a.data.tailNumber).toBe("AF86-0147");
    act(() => setId("AF86-0212"));
    await until(() => {
      const s = view.latest();
      return s.status === "success" && s.data.tailNumber === "AF86-0212";
    });

    const anonymous = await mount("anonymous", () => useObject("airforce.Aircraft", "AF86-0147"));
    await until(() => anonymous.latest().status === "error");
  });

  it("useAction previews, then invokes; a caller the policy refuses sees the refusal and nothing runs", async () => {
    const input = { maintenanceEventId: "EVT-9001", assignedTo: "SSgt Rivera" };
    const before = (await testbed.runtime.query({ type: "airforce.WorkOrder" }, demoIdentities.maintainer)).items.length;

    const viewer = await mount("viewer", () => useAction("CreateMaintenanceWorkOrder"));
    await act(() => viewer.latest().preview(input));
    expect(viewer.latest().previewed).toMatchObject({ status: "success", data: { authorized: false, wouldExecute: false } });
    await act(() => viewer.latest().invoke(input));
    expect(viewer.latest().invoked).toMatchObject({ status: "error", error: { message: expect.stringMatching(/not authorized|denied|Requires/i) as string } });
    expect((await testbed.runtime.query({ type: "airforce.WorkOrder" }, demoIdentities.maintainer)).items.length).toBe(before);

    const maintainer = await mount("maintainer", () => useAction("CreateMaintenanceWorkOrder"));
    await act(() => maintainer.latest().preview(input));
    expect(maintainer.latest().previewed).toMatchObject({ status: "success", data: { authorized: true, wouldExecute: true } });
    await act(() => maintainer.latest().invoke(input));
    expect(maintainer.latest().invoked.status).toBe("success");
    expect((await testbed.runtime.query({ type: "airforce.WorkOrder" }, demoIdentities.maintainer)).items.length).toBe(before + 1);
    act(() => maintainer.latest().reset());
    expect(maintainer.latest().previewed.status).toBe("idle");
  });

  it("useActions lists what this caller may invoke on one object", async () => {
    const view = await mount("viewer", () => useActions("airforce.MaintenanceEvent", "EVT-9001"));
    await until(() => view.latest().status === "success");
    const s = view.latest();
    expect(s.status === "success" && s.data.find((a) => a.name === "CreateMaintenanceWorkOrder")).toMatchObject({ authorized: false });
  });

  it("a hook outside its provider says so", async () => {
    function Lost(): null {
      useObject("airforce.Aircraft", "AF86-0147");
      return null;
    }
    const quiet = console.error;
    console.error = () => undefined;
    try {
      let thrown: unknown;
      try {
        await act(async () => void create(createElement(Lost)));
      } catch (err) {
        thrown = err;
      }
      expect(String(thrown)).toMatch(/outside its TypeSProvider/);
    } finally {
      console.error = quiet;
    }
  });
});

describe("forms and columns from the model (ADR-0058)", () => {
  const action = (name: string) => model.actions.find((a) => a.name === name)!;

  it("reads an Action's fields from its input schema, with enum values as options", () => {
    expect(formFields(action("UpdateWorkOrderStatus"))).toEqual([
      { name: "workOrderId", label: "Work order id", kind: "text", required: true, objectOf: "airforce.WorkOrder" },
      { name: "status", label: "Status", kind: "select", required: true, options: ["open", "in-progress", "closed"] }
    ]);
    expect(formFields(action("CreateMaintenanceWorkOrder")).map((f) => [f.name, f.kind, f.required])).toEqual([
      ["maintenanceEventId", "text", true],
      ["assignedTo", "text", true]
    ]);
    const scoped = formFields({ inputSchema: { type: "object", properties: { id: { type: "string" }, n: { type: "integer", minimum: 1, maximum: 9 }, at: { type: "string", format: "date-time" }, tags: { type: "array" }, ok: { type: "boolean" } } }, target: { type: "x.T", idFrom: "id" } });
    expect(scoped.map((f) => [f.name, f.kind])).toEqual([["id", "text"], ["n", "integer"], ["at", "date-time"], ["tags", "json"], ["ok", "boolean"]]);
    expect(scoped[0]).toMatchObject({ objectOf: "x.T", required: false });
    expect(scoped[1]).toMatchObject({ min: 1, max: 9 });
  });

  it("coerces control values into the input, leaving empty ones for the runtime to refuse", () => {
    const fields = formFields({ inputSchema: { type: "object", properties: { s: { type: "string" }, n: { type: "number" }, i: { type: "integer" }, b: { type: "boolean" }, e: { enum: [1, 2] }, j: { type: "object" } } } });
    expect(coerceForm(fields, { s: "x", n: " 2.5 ", i: "3", b: "false", e: "2", j: '{"a":1}' })).toEqual({ value: { s: "x", n: 2.5, i: 3, b: false, e: 2, j: { a: 1 } }, errors: {} });
    expect(coerceForm(fields, { s: "", n: "x", i: "1.5", b: "maybe", e: "3", j: "{" }).errors).toEqual({
      n: "Not a number",
      i: "Not a whole number",
      b: "Not true or false",
      e: "Not one of the options",
      j: "Not valid JSON"
    });
    expect(coerceForm(fields, { s: "", b: true }).value).toEqual({ b: true });
  });

  it("gives a Type's columns, stored then computed, and only stored ones sort", () => {
    const aircraft = model.types.find((t) => t.name === "airforce.Aircraft")!;
    const cols = columnsFor(aircraft, ["tailNumber", "maintenanceStatus", "lastMaintainedAt", "readinessStatus", "needsAttention"]);
    expect(cols.map((c) => [c.key, c.kind, c.sortable, c.computed])).toEqual([
      ["tailNumber", "text", true, false],
      ["maintenanceStatus", "select", true, false],
      ["lastMaintainedAt", "date-time", true, false],
      ["readinessStatus", "select", false, true],
      ["needsAttention", "boolean", false, true]
    ]);
    expect(cols[3]).toMatchObject({ label: "Readiness status", options: ["FMC", "PMC", "NMC", "UNKNOWN"] });
    expect(columnsFor(aircraft).at(-1)?.key).toBe("needsAttention");
    expect(() => columnsFor(aircraft, ["nope"])).toThrow(/No value "nope"/);
  });
});
