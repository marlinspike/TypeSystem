// Hidden acceptance tests: Component replacement (airforce model).
// Data: aircraft AF86-0147 (maintenanceStatus "degraded") and AF86-0212;
// components comp-001, comp-002 on AF86-0147, comp-003 on AF86-0212;
// maintenance events EVT-9001, EVT-9002, both on AF86-0147; no work orders.

const MAINTAINER = "demo-maintainer-token"; // SSgt Rivera
const LEAD = "demo-lead-token"; // MSgt Okafor
const VIEWER = "demo-viewer-token";
const ANON = "";
const WF = "/api/workflows/airforce.ReplaceComponent/runs";

function fail(msg) {
  throw new Error(msg);
}
function show(res) {
  return `${res.status} ${JSON.stringify(res.body)}`;
}
function expectStatus(res, code, what) {
  if (res.status !== code) fail(`${what}: expected HTTP ${code}, got ${show(res)}`);
}
async function start(api, token, input) {
  return api.call(token, "POST", WF, { input });
}
async function startWaiting(api, token, input) {
  const res = await start(api, token, input);
  expectStatus(res, 201, `start airforce.ReplaceComponent ${JSON.stringify(input)}`);
  if (res.body?.status !== "waiting-approval") fail(`expected run status "waiting-approval", got ${show(res)}`);
  if (res.body?.waitingOn?.step !== "leadApproval") fail(`expected waitingOn.step "leadApproval", got ${show(res)}`);
  if (typeof res.body?.runId !== "string" || !res.body.runId) fail(`expected a runId, got ${show(res)}`);
  return res.body.runId;
}
function approve(api, token, runId) {
  return api.call(token, "POST", `/api/workflow-runs/${encodeURIComponent(runId)}/approvals/leadApproval`, { approved: true });
}
async function workOrdersFor(api, token, eventId) {
  const res = await api.call(token, "POST", "/api/query", {
    type: "airforce.WorkOrder",
    filter: { property: "maintenanceEventId", operator: "eq", value: eventId }
  });
  expectStatus(res, 200, `query airforce.WorkOrder for ${eventId}`);
  if (!Array.isArray(res.body?.items)) fail(`query answer has no items array: ${show(res)}`);
  return res.body.items;
}
const VALID = { componentId: "comp-002", maintenanceEventId: "EVT-9002", assignTo: "SSgt Rivera" };

export default [
  {
    id: "cr-maintainer-requests",
    requirement: "When a component on an aircraft needs replacing, a maintainer requests the replacement against one of that aircraft's maintenance events.",
    run: async (api) => {
      const runId = await startWaiting(api, MAINTAINER, VALID);
      const got = await api.call(MAINTAINER, "GET", `/api/workflow-runs/${encodeURIComponent(runId)}`);
      expectStatus(got, 200, "the requester reads the run");
      if (got.body?.status !== "waiting-approval") fail(`run should still be waiting-approval, got ${show(got)}`);
      // Contract: a run reads back to its starter and to anyone who may approve the step it waits on; 404 to anyone else.
      const byLead = await api.call(LEAD, "GET", `/api/workflow-runs/${encodeURIComponent(runId)}`);
      expectStatus(byLead, 200, "the lead (who may approve leadApproval) reads the waiting run");
      if (byLead.body?.status !== "waiting-approval") fail(`the lead should read the run as waiting-approval, got ${show(byLead)}`);
      expectStatus(await api.call(VIEWER, "GET", `/api/workflow-runs/${encodeURIComponent(runId)}`), 404, "the viewer (neither requester nor approver) reads the run");
    }
  },
  {
    id: "cr-no-work-order-before-approval",
    requirement: "A maintenance lead other than the requester approves it, and only then is a work order opened and assigned",
    run: async (api) => {
      await startWaiting(api, MAINTAINER, VALID);
      const items = await workOrdersFor(api, LEAD, "EVT-9002");
      if (items.length !== 0) fail(`no work order may exist before lead approval, found ${JSON.stringify(items)}`);
    }
  },
  {
    id: "cr-lead-approves-opens-and-assigns-work-order",
    requirement: "A maintenance lead other than the requester approves it, and only then is a work order opened and assigned",
    run: async (api) => {
      const runId = await startWaiting(api, MAINTAINER, VALID);
      const ap = await approve(api, LEAD, runId);
      expectStatus(ap, 200, "lead approves leadApproval");
      if (ap.body?.status !== "completed") fail(`after lead approval the run should be completed, got ${show(ap)}`);
      const got = await api.call(MAINTAINER, "GET", `/api/workflow-runs/${encodeURIComponent(runId)}`);
      expectStatus(got, 200, "the requester reads the run");
      if (got.body?.status !== "completed") fail(`run should read back completed, got ${show(got)}`);
      const items = await workOrdersFor(api, MAINTAINER, "EVT-9002");
      if (items.length !== 1) fail(`expected exactly one work order on EVT-9002, got ${JSON.stringify(items)}`);
      const v = items[0].values ?? {};
      if (v.maintenanceEventId !== "EVT-9002") fail(`work order maintenanceEventId should be EVT-9002, got ${JSON.stringify(v)}`);
      if (v.assignedTo !== "SSgt Rivera") fail(`work order should be assigned to "SSgt Rivera" (assignTo), got ${JSON.stringify(v)}`);
      // "opened": an open work order is open or in-progress; closed would mean it was compensated.
      if (v.status !== "open" && v.status !== "in-progress") fail(`work order should be open, got status ${JSON.stringify(v.status)}`);
    }
  },
  {
    id: "cr-assign-to-is-used",
    requirement: "The workflow is `airforce.ReplaceComponent`, with inputs `componentId`, `maintenanceEventId` and `assignTo` (the work order's assignee).",
    run: async (api) => {
      const runId = await startWaiting(api, MAINTAINER, { componentId: "comp-001", maintenanceEventId: "EVT-9001", assignTo: "MSgt Okafor" });
      const ap = await approve(api, LEAD, runId);
      expectStatus(ap, 200, "lead approves leadApproval");
      const items = await workOrdersFor(api, LEAD, "EVT-9001");
      if (items.length !== 1) fail(`expected exactly one work order on EVT-9001, got ${JSON.stringify(items)}`);
      if (items[0].values?.assignedTo !== "MSgt Okafor") fail(`assignedTo should be "MSgt Okafor", got ${JSON.stringify(items[0].values)}`);
    }
  },
  {
    id: "cr-requester-maintainer-cannot-approve",
    requirement: "A maintenance lead other than the requester approves it",
    run: async (api) => {
      const runId = await startWaiting(api, MAINTAINER, VALID);
      const ap = await approve(api, MAINTAINER, runId);
      expectStatus(ap, 403, "requesting maintainer (not a lead) approves");
      const items = await workOrdersFor(api, LEAD, "EVT-9002");
      if (items.length !== 0) fail(`a refused approval must not open a work order, found ${JSON.stringify(items)}`);
    }
  },
  {
    id: "cr-lead-cannot-approve-own-request",
    requirement: "A maintenance lead other than the requester approves it",
    run: async (api) => {
      // MSgt Okafor is a maintainer and a lead, so may request; he may not approve his own request.
      const runId = await startWaiting(api, LEAD, VALID);
      const ap = await approve(api, LEAD, runId);
      expectStatus(ap, 403, "lead approves a replacement he requested himself");
      const got = await api.call(LEAD, "GET", `/api/workflow-runs/${encodeURIComponent(runId)}`);
      expectStatus(got, 200, "read the run");
      if (got.body?.status !== "waiting-approval") fail(`run should still be waiting-approval, got ${show(got)}`);
      const items = await workOrdersFor(api, LEAD, "EVT-9002");
      if (items.length !== 0) fail(`a self-approval must not open a work order, found ${JSON.stringify(items)}`);
    }
  },
  {
    id: "cr-viewer-and-anonymous-cannot-approve",
    requirement: "A maintenance lead other than the requester approves it",
    run: async (api) => {
      const runId = await startWaiting(api, MAINTAINER, VALID);
      expectStatus(await approve(api, VIEWER, runId), 403, "viewer approves");
      expectStatus(await approve(api, ANON, runId), 403, "someone not signed in approves");
    }
  },
  {
    id: "cr-different-aircraft-fails",
    requirement: "A request whose component and maintenance event are on different aircraft fails.",
    run: async (api) => {
      // comp-003 is on AF86-0212; EVT-9001 is on AF86-0147.
      const res = await start(api, MAINTAINER, { componentId: "comp-003", maintenanceEventId: "EVT-9001", assignTo: "SSgt Rivera" });
      expectStatus(res, 201, "start with component and event on different aircraft");
      if (res.body?.status !== "failed") fail(`expected status "failed", got ${show(res)}`);
      if (res.body?.waitingOn) fail(`a failed run never waits for approval, got ${show(res)}`);
      const items = await workOrdersFor(api, LEAD, "EVT-9001");
      if (items.length !== 0) fail(`a failed request must not open a work order, found ${JSON.stringify(items)}`);
    }
  },
  {
    id: "cr-viewer-cannot-request",
    requirement: "Viewers can see the fleet's components and aircraft without their maintenance status, and cannot request a replacement or open a work order.",
    run: async (api) => {
      expectStatus(await start(api, VIEWER, VALID), 403, "viewer starts airforce.ReplaceComponent");
      const items = await workOrdersFor(api, LEAD, "EVT-9002");
      if (items.length !== 0) fail(`a viewer's refused request must not open a work order, found ${JSON.stringify(items)}`);
    }
  },
  {
    id: "cr-viewer-sees-aircraft-without-maintenance-status",
    requirement: "Viewers can see the fleet's components and aircraft without their maintenance status",
    run: async (api) => {
      const m = await api.call(MAINTAINER, "GET", "/api/objects/airforce.Aircraft/AF86-0147");
      expectStatus(m, 200, "maintainer reads AF86-0147");
      if (m.body?.values?.maintenanceStatus !== "degraded") fail(`maintainer should read maintenanceStatus "degraded", got ${show(m)}`);
      const v = await api.call(VIEWER, "GET", "/api/objects/airforce.Aircraft/AF86-0147");
      expectStatus(v, 200, "viewer reads AF86-0147");
      const vals = v.body?.values ?? {};
      if (vals.tailNumber !== "AF86-0147" || vals.model !== "F-16C") fail(`viewer should see tailNumber and model, got ${show(v)}`);
      if ("maintenanceStatus" in vals) fail(`maintenanceStatus must be absent for a viewer, got ${show(v)}`);
      // readinessStatus maps maintenanceStatus one to one, so it is the maintenance status too.
      if ("readinessStatus" in vals) fail(`readinessStatus (derived from maintenanceStatus) must be absent for a viewer, got ${show(v)}`);
    }
  },
  {
    id: "cr-viewer-query-fleet-without-maintenance-status",
    requirement: "Viewers can see the fleet's components and aircraft without their maintenance status",
    run: async (api) => {
      const res = await api.call(VIEWER, "POST", "/api/query", { type: "airforce.Aircraft" });
      expectStatus(res, 200, "viewer queries airforce.Aircraft");
      const items = res.body?.items ?? [];
      const ids = items.map((i) => i.objectId).sort();
      if (JSON.stringify(ids) !== JSON.stringify(["AF86-0147", "AF86-0212"])) fail(`viewer should see both aircraft, got ${JSON.stringify(ids)}`);
      for (const i of items) {
        if (!i.values || i.values.tailNumber !== i.objectId) fail(`aircraft values missing tailNumber: ${JSON.stringify(i)}`);
        if ("maintenanceStatus" in i.values) fail(`maintenanceStatus must be absent for a viewer: ${JSON.stringify(i)}`);
      }
    }
  },
  {
    id: "cr-viewer-sees-components",
    requirement: "Viewers can see the fleet's components and aircraft without their maintenance status",
    run: async (api) => {
      const one = await api.call(VIEWER, "GET", "/api/objects/airforce.Component/comp-002");
      expectStatus(one, 200, "viewer reads comp-002");
      const v = one.body?.values ?? {};
      if (v.partNumber !== "AVI-200" || v.aircraftId !== "AF86-0147") fail(`comp-002 should be AVI-200 on AF86-0147, got ${show(one)}`);
      const res = await api.call(VIEWER, "POST", "/api/query", { type: "airforce.Component" });
      expectStatus(res, 200, "viewer queries airforce.Component");
      const ids = (res.body?.items ?? []).map((i) => i.objectId).sort();
      if (JSON.stringify(ids) !== JSON.stringify(["comp-001", "comp-002", "comp-003"])) fail(`viewer should see all three components, got ${JSON.stringify(ids)}`);
    }
  },
  {
    id: "cr-anonymous-sees-nothing",
    requirement: "Someone not signed in sees nothing.",
    run: async (api) => {
      expectStatus(await api.call(ANON, "GET", "/api/objects/airforce.Aircraft/AF86-0147"), 403, "anonymous reads AF86-0147");
      expectStatus(await api.call(ANON, "GET", "/api/objects/airforce.Component/comp-001"), 403, "anonymous reads comp-001");
      expectStatus(await api.call(ANON, "GET", "/api/objects/airforce.MaintenanceEvent/EVT-9001"), 403, "anonymous reads EVT-9001");
      // Contract: a query answers 403 when the caller may read no object of that Type at all.
      for (const type of ["airforce.Aircraft", "airforce.Component", "airforce.MaintenanceEvent", "airforce.WorkOrder"]) {
        expectStatus(await api.call(ANON, "POST", "/api/query", { type }), 403, `anonymous queries ${type}`);
      }
    }
  },
  {
    id: "cr-anonymous-cannot-request",
    requirement: "Someone not signed in sees nothing.",
    run: async (api) => {
      expectStatus(await start(api, ANON, VALID), 403, "anonymous starts airforce.ReplaceComponent");
    }
  }
  // ambiguous: "if the work order cannot finish, it is closed again" names a compensation, but the
  // requirement gives no way for a caller to make the work order fail to finish through the contract,
  // so that path is untested. Only the success path's work order (open, not closed) is asserted.
  // ambiguous: a request naming a component or maintenance event that does not exist is not
  // specified (failed run or 404), so it is untested.
];
