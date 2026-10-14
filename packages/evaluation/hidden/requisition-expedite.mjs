// Hidden acceptance tests: Requisition expedite (sortie model, default host: depot key KHIF only).
// Data: KHIF-6282-0003 "Turbine blade set" awaiting; KHIF-6281-0001 in-transit; KHIF-6281-0002 issued;
// KVPS-6280-0001 awaiting but at KVPS, which the default depot key cannot read.

const PLANNER = "demo-planner-token"; // Maj Chen
const MAINTAINER = "demo-maintainer-token"; // TSgt Ruiz
const VIEWER = "demo-viewer-token";
const ANON = "";
const WF = "/api/workflows/ops.ExpediteRequisition/runs";

function fail(msg) {
  throw new Error(msg);
}
function show(res) {
  return `${res.status} ${JSON.stringify(res.body)}`;
}
function expectStatus(res, code, what) {
  if (res.status !== code) fail(`${what}: expected HTTP ${code}, got ${show(res)}`);
}
function start(api, token, input) {
  return api.call(token, "POST", WF, { input });
}
async function startWaiting(api, token, input) {
  const res = await start(api, token, input);
  expectStatus(res, 201, `start ops.ExpediteRequisition ${JSON.stringify(input)}`);
  if (res.body?.status !== "waiting-approval") fail(`expected run status "waiting-approval", got ${show(res)}`);
  if (res.body?.waitingOn?.step !== "plannerApproval") fail(`expected waitingOn.step "plannerApproval", got ${show(res)}`);
  if (typeof res.body?.runId !== "string" || !res.body.runId) fail(`expected a runId, got ${show(res)}`);
  return res.body.runId;
}
function approve(api, token, runId) {
  return api.call(token, "POST", `/api/workflow-runs/${encodeURIComponent(runId)}/approvals/plannerApproval`, { approved: true });
}
async function expectFailedRun(api, token, input, what) {
  const res = await start(api, token, input);
  expectStatus(res, 201, what);
  if (res.body?.status !== "failed") fail(`${what}: expected status "failed", got ${show(res)}`);
  if (res.body?.waitingOn) fail(`${what}: a failed run never waits for approval, got ${show(res)}`);
}
const VALID = { requisitionId: "KHIF-6282-0003", reason: "AF88-0405 is NMC awaiting the turbine blade set" };

export default [
  {
    id: "re-maintainer-asks",
    requirement: "A maintainer asks to expedite a parts requisition that is still awaiting shipment, giving a reason.",
    run: async (api) => {
      const runId = await startWaiting(api, MAINTAINER, VALID);
      const got = await api.call(MAINTAINER, "GET", `/api/workflow-runs/${encodeURIComponent(runId)}`);
      expectStatus(got, 200, "the maintainer who asked reads the run");
      if (got.body?.status !== "waiting-approval") fail(`run should be waiting-approval, got ${show(got)}`);
      // Contract: a run reads back to its starter and to anyone who may approve the step it waits on; 404 to anyone else.
      const byPlanner = await api.call(PLANNER, "GET", `/api/workflow-runs/${encodeURIComponent(runId)}`);
      expectStatus(byPlanner, 200, "the planner (who may approve plannerApproval) reads the waiting run");
      if (byPlanner.body?.status !== "waiting-approval") fail(`the planner should read the run as waiting-approval, got ${show(byPlanner)}`);
      expectStatus(await api.call(VIEWER, "GET", `/api/workflow-runs/${encodeURIComponent(runId)}`), 404, "the viewer (neither initiator nor approver) reads the run");
    }
  },
  {
    id: "re-planner-approves",
    requirement: "A planner approves the request, though never one they asked for themselves; a maintainer cannot approve one, their own or anyone's.",
    run: async (api) => {
      const runId = await startWaiting(api, MAINTAINER, VALID);
      const ap = await approve(api, PLANNER, runId);
      expectStatus(ap, 200, "planner approves plannerApproval");
      if (ap.body?.status !== "completed") fail(`after planner approval the run should be completed, got ${show(ap)}`);
      const got = await api.call(MAINTAINER, "GET", `/api/workflow-runs/${encodeURIComponent(runId)}`);
      expectStatus(got, 200, "the maintainer who asked reads the run");
      if (got.body?.status !== "completed") fail(`run should read back completed, got ${show(got)}`);
    }
  },
  {
    id: "re-maintainer-cannot-approve-own",
    requirement: "a maintainer cannot approve one, their own or anyone's.",
    run: async (api) => {
      const runId = await startWaiting(api, MAINTAINER, VALID);
      expectStatus(await approve(api, MAINTAINER, runId), 403, "maintainer approves their own request");
      const got = await api.call(MAINTAINER, "GET", `/api/workflow-runs/${encodeURIComponent(runId)}`);
      expectStatus(got, 200, "read the run");
      if (got.body?.status !== "waiting-approval") fail(`run should still be waiting-approval, got ${show(got)}`);
      // A planner can still approve it afterwards.
      const ap = await approve(api, PLANNER, runId);
      expectStatus(ap, 200, "planner approves after the maintainer was refused");
      if (ap.body?.status !== "completed") fail(`run should be completed, got ${show(ap)}`);
    }
  },
  {
    id: "re-maintainer-cannot-approve-anyones",
    requirement: "a maintainer cannot approve one, their own or anyone's.",
    run: async (api) => {
      const runId = await startWaiting(api, PLANNER, VALID);
      expectStatus(await approve(api, MAINTAINER, runId), 403, "maintainer approves the planner's request");
      const got = await api.call(PLANNER, "GET", `/api/workflow-runs/${encodeURIComponent(runId)}`);
      expectStatus(got, 200, "the planner who asked reads the run");
      if (got.body?.status !== "waiting-approval") fail(`run should still be waiting-approval, got ${show(got)}`);
    }
  },
  {
    id: "re-planner-may-ask",
    requirement: "A planner may ask too.",
    run: async (api) => {
      await startWaiting(api, PLANNER, VALID);
    }
  },
  {
    id: "re-planner-cannot-approve-own",
    requirement: "A planner approves the request, though never one they asked for themselves",
    run: async (api) => {
      // Maj Chen is the only planner, so a request she makes can be approved by no one here.
      const runId = await startWaiting(api, PLANNER, VALID);
      expectStatus(await approve(api, PLANNER, runId), 403, "planner approves a request she asked for herself");
      const got = await api.call(PLANNER, "GET", `/api/workflow-runs/${encodeURIComponent(runId)}`);
      expectStatus(got, 200, "the planner who asked reads the run");
      if (got.body?.status !== "waiting-approval") fail(`run should still be waiting-approval, got ${show(got)}`);
    }
  },
  {
    id: "re-viewer-and-anonymous-cannot-approve",
    requirement: "A planner approves the request",
    run: async (api) => {
      const runId = await startWaiting(api, MAINTAINER, VALID);
      expectStatus(await approve(api, VIEWER, runId), 403, "viewer approves");
      expectStatus(await approve(api, ANON, runId), 403, "someone not signed in approves");
    }
  },
  {
    id: "re-in-transit-fails",
    requirement: "A requisition already in transit or issued cannot be expedited: the request fails.",
    run: async (api) => {
      await expectFailedRun(api, MAINTAINER, { requisitionId: "KHIF-6281-0001", reason: "need the radar processor" }, "expedite in-transit KHIF-6281-0001");
    }
  },
  {
    id: "re-issued-fails",
    requirement: "A requisition already in transit or issued cannot be expedited: the request fails.",
    run: async (api) => {
      await expectFailedRun(api, MAINTAINER, { requisitionId: "KHIF-6281-0002", reason: "need the canopy seal" }, "expedite issued KHIF-6281-0002");
    }
  },
  {
    id: "re-reason-required",
    requirement: "A maintainer asks to expedite a parts requisition that is still awaiting shipment, giving a reason.",
    run: async (api) => {
      // ambiguous: the contract has no 400; a missing reason may be refused as bad input (400) or answered
      // 201 with status failed. Either is accepted; waiting for approval or completing is not.
      for (const input of [{ requisitionId: "KHIF-6282-0003" }, { requisitionId: "KHIF-6282-0003", reason: "" }]) {
        const res = await start(api, MAINTAINER, input);
        if (res.status === 201) {
          if (res.body?.status !== "failed") fail(`request without a reason ${JSON.stringify(input)} must fail, got ${show(res)}`);
        } else if (res.status !== 400) {
          fail(`request without a reason ${JSON.stringify(input)}: expected 201 failed or 400, got ${show(res)}`);
        }
      }
    }
  },
  {
    id: "re-viewer-cannot-ask",
    requirement: "A viewer cannot ask, and reads no requisition.",
    run: async (api) => {
      expectStatus(await start(api, VIEWER, VALID), 403, "viewer starts ops.ExpediteRequisition");
    }
  },
  {
    id: "re-viewer-reads-no-requisition",
    requirement: "A viewer cannot ask, and reads no requisition.",
    run: async (api) => {
      const m = await api.call(MAINTAINER, "GET", "/api/objects/ops.Requisition/KHIF-6282-0003");
      expectStatus(m, 200, "maintainer reads KHIF-6282-0003");
      if (m.body?.values?.status !== "awaiting" || m.body?.values?.tailNumber !== "AF88-0405") fail(`KHIF-6282-0003 should be awaiting for AF88-0405, got ${show(m)}`);
      for (const id of ["KHIF-6282-0003", "KHIF-6281-0001", "KHIF-6281-0002"]) {
        expectStatus(await api.call(VIEWER, "GET", `/api/objects/ops.Requisition/${id}`), 403, `viewer reads requisition ${id}`);
      }
      // Contract: a query answers 403 when the caller may read no object of that Type at all.
      expectStatus(await api.call(VIEWER, "POST", "/api/query", { type: "ops.Requisition" }), 403, "viewer queries ops.Requisition");
      expectStatus(
        await api.call(VIEWER, "POST", "/api/query", { type: "ops.Requisition", filter: { property: "status", operator: "eq", value: "awaiting" } }),
        403,
        "viewer queries awaiting ops.Requisition"
      );
    }
  },
  {
    id: "re-anonymous-sees-nothing",
    requirement: "Someone not signed in sees nothing.",
    run: async (api) => {
      expectStatus(await api.call(ANON, "GET", "/api/objects/ops.Requisition/KHIF-6282-0003"), 403, "anonymous reads KHIF-6282-0003");
      expectStatus(await api.call(ANON, "GET", "/api/objects/ops.Aircraft/AF88-0405"), 403, "anonymous reads AF88-0405");
      expectStatus(await api.call(ANON, "GET", "/api/objects/ops.CrewMember/C-1001"), 403, "anonymous reads C-1001");
      // Contract: a query answers 403 when the caller may read no object of that Type at all.
      for (const type of ["ops.Requisition", "ops.Aircraft", "ops.CrewMember"]) {
        expectStatus(await api.call(ANON, "POST", "/api/query", { type }), 403, `anonymous queries ${type}`);
      }
    }
  },
  {
    id: "re-anonymous-cannot-ask",
    requirement: "Someone not signed in sees nothing.",
    run: async (api) => {
      expectStatus(await start(api, ANON, VALID), 403, "anonymous starts ops.ExpediteRequisition");
    }
  }
  // ambiguous: KVPS-6280-0001 is awaiting, but the default host's depot key (depot-hill-key) is issued for
  // KHIF only, so the depot itself refuses it; whether the application answers that read with 403 or 404,
  // and the expedite with 403 or a failed run, is not specified, so it is untested.
  // ambiguous: a requisitionId that does not exist (failed run or 404) is not specified; untested.
  // ambiguous: the requirement does not say the approved expedite changes anything observable on the
  // requisition (the depot is read-only), so only the run's status is asserted after approval.
];
