// Hidden acceptance tests: Sortie confirmation (sortie model, rosterPii: true).
// Data: fleet registry airframes AF86-0147 (PMC -> "partial"), AF87-0212, AF88-0405, AF09-4126 (419FW),
// AF12-5052; crew roster C-1001 VIPER "Capt Dana Reyes" and C-1002 TALON on AF86-0147 (388FW),
// C-1003 RAVEN on AF87-0212 (388FW, on leave), C-2001 GHOST "Capt Ana Silva" on AF09-4126 (419FW);
// parts depot (KHIF key) KHIF-6281-0001 and KHIF-6281-0002 on AF86-0147, KHIF-6282-0003 on AF88-0405.

const PLANNER = "demo-planner-token"; // Maj Chen, 388FW
const MAINTAINER = "demo-maintainer-token"; // TSgt Ruiz, 388FW
const VIEWER = "demo-viewer-token";
const ANON = "";
const WF = "/api/workflows/ops.ConfirmSortie/runs";

function fail(msg) {
  throw new Error(msg);
}
function show(res) {
  return `${res.status} ${JSON.stringify(res.body)}`;
}
function expectStatus(res, code, what) {
  if (res.status !== code) fail(`${what}: expected HTTP ${code}, got ${show(res)}`);
}

/**
 * A refusal means something only where the application grants what it
 * should: a caller allowed to read must read. Every negative check starts
 * here, so an application that refuses everything passes none (P3-V1).
 */
async function expectServing(api) {
  expectStatus(await api.call(PLANNER, "GET", "/api/objects/ops.Aircraft/AF86-0147"), 200, "planner reads AF86-0147 (a refusal below means something only if this is allowed)");
}
function start(api, token, input) {
  return api.call(token, "POST", WF, { input });
}
async function startWaiting(api, token, input) {
  const res = await start(api, token, input);
  expectStatus(res, 201, `start ops.ConfirmSortie ${JSON.stringify(input)}`);
  if (res.body?.status !== "waiting-approval") fail(`expected run status "waiting-approval", got ${show(res)}`);
  if (res.body?.waitingOn?.step !== "plannerSignoff") fail(`expected waitingOn.step "plannerSignoff", got ${show(res)}`);
  if (typeof res.body?.runId !== "string" || !res.body.runId) fail(`expected a runId, got ${show(res)}`);
  return res.body.runId;
}
function approve(api, token, runId) {
  return api.call(token, "POST", `/api/workflow-runs/${encodeURIComponent(runId)}/approvals/plannerSignoff`, { approved: true });
}
async function query(api, token, type, filter) {
  const res = await api.call(token, "POST", "/api/query", filter ? { type, filter } : { type });
  expectStatus(res, 200, `query ${type}${filter ? " " + JSON.stringify(filter) : ""}`);
  if (!Array.isArray(res.body?.items)) fail(`query answer has no items array: ${show(res)}`);
  return res.body.items;
}
const VALID = { tailNumber: "AF86-0147", pilotId: "C-1001" };

export default [
  {
    id: "sc-maintainer-asks-planner-confirms",
    requirement: "A maintainer may ask for the confirmation; only a planner may give it, and never for a pilot not assigned to that aircraft.",
    run: async (api) => {
      const runId = await startWaiting(api, MAINTAINER, VALID);
      const ap = await approve(api, PLANNER, runId);
      expectStatus(ap, 200, "planner signs off");
      if (ap.body?.status !== "completed") fail(`after planner sign-off the run should be completed, got ${show(ap)}`);
      const got = await api.call(MAINTAINER, "GET", `/api/workflow-runs/${encodeURIComponent(runId)}`);
      expectStatus(got, 200, "the maintainer who asked reads the run");
      if (got.body?.status !== "completed") fail(`run should read back completed, got ${show(got)}`);
      // Contract: a run reads back to its starter and to anyone who may approve the step it waits on; 404 to anyone else.
      // ambiguous: whether the planner who signed off may still read the run once it is completed (it waits on no
      // step any more) is not plain from the contract, so only the viewer, who neither asked nor may sign off, is asserted.
      expectStatus(await api.call(VIEWER, "GET", `/api/workflow-runs/${encodeURIComponent(runId)}`), 404, "the viewer (neither initiator nor approver) reads the run");
    }
  },
  {
    id: "sc-planner-may-ask",
    requirement: "A maintainer may ask for the confirmation, and so may a planner",
    run: async (api) => {
      const runId = await startWaiting(api, PLANNER, { tailNumber: "AF86-0147", pilotId: "C-1002" });
      const got = await api.call(PLANNER, "GET", `/api/workflow-runs/${encodeURIComponent(runId)}`);
      expectStatus(got, 200, "the planner who asked reads the run");
      if (got.body?.status !== "waiting-approval") fail(`run should be waiting-approval, got ${show(got)}`);
    }
  },
  {
    id: "sc-planner-cannot-sign-own",
    requirement: "only a planner may give it, never for a confirmation they asked for themselves",
    run: async (api) => {
      // Maj Chen is the only planner, so a confirmation she asks for can be signed off by no one here.
      const runId = await startWaiting(api, PLANNER, { tailNumber: "AF86-0147", pilotId: "C-1002" });
      expectStatus(await approve(api, PLANNER, runId), 403, "planner signs off a confirmation she asked for herself");
      expectStatus(await approve(api, MAINTAINER, runId), 403, "maintainer signs off the planner's confirmation");
      const got = await api.call(PLANNER, "GET", `/api/workflow-runs/${encodeURIComponent(runId)}`);
      expectStatus(got, 200, "the planner who asked reads the run");
      if (got.body?.status !== "waiting-approval") fail(`run should still be waiting-approval, got ${show(got)}`);
    }
  },
  {
    id: "sc-maintainer-cannot-give",
    requirement: "A maintainer may ask for the confirmation; only a planner may give it",
    run: async (api) => {
      const runId = await startWaiting(api, MAINTAINER, VALID);
      expectStatus(await approve(api, MAINTAINER, runId), 403, "maintainer signs off");
      const got = await api.call(MAINTAINER, "GET", `/api/workflow-runs/${encodeURIComponent(runId)}`);
      expectStatus(got, 200, "read the run");
      if (got.body?.status !== "waiting-approval") fail(`run should still be waiting-approval, got ${show(got)}`);
    }
  },
  {
    id: "sc-viewer-and-anonymous-cannot-give",
    requirement: "only a planner may give it",
    run: async (api) => {
      const runId = await startWaiting(api, MAINTAINER, VALID);
      expectStatus(await approve(api, VIEWER, runId), 403, "viewer signs off");
      expectStatus(await approve(api, ANON, runId), 403, "someone not signed in signs off");
    }
  },
  {
    id: "sc-unassigned-pilot-fails",
    requirement: "only a planner may give it, and never for a pilot not assigned to that aircraft.",
    run: async (api) => {
      // C-1003 RAVEN is assigned to AF87-0212, not AF86-0147.
      const res = await start(api, MAINTAINER, { tailNumber: "AF86-0147", pilotId: "C-1003" });
      expectStatus(res, 201, "start with a pilot not assigned to the aircraft");
      if (res.body?.status !== "failed") fail(`expected status "failed", got ${show(res)}`);
      if (res.body?.waitingOn) fail(`a failed run never waits for approval, got ${show(res)}`);
    }
  },
  {
    id: "sc-other-unit-pilot-fails",
    requirement: "never for a pilot not assigned to that aircraft.",
    run: async (api) => {
      // C-2001 GHOST is assigned to AF09-4126, not AF87-0212.
      const res = await start(api, PLANNER, { tailNumber: "AF87-0212", pilotId: "C-2001" });
      expectStatus(res, 201, "start with a pilot not assigned to the aircraft");
      if (res.body?.status !== "failed") fail(`expected status "failed", got ${show(res)}`);
    }
  },
  {
    id: "sc-viewer-and-anonymous-cannot-ask",
    requirement: "Its policy rule `ops.sortie-signoff` says who may sign off, and `ops.crew` who may ask.",
    run: async (api) => {
      await expectServing(api);
      expectStatus(await start(api, VIEWER, VALID), 403, "viewer starts ops.ConfirmSortie");
      expectStatus(await start(api, ANON, VALID), 403, "someone not signed in starts ops.ConfirmSortie");
    }
  },
  {
    id: "sc-viewer-sees-fleet-without-mission-capability",
    requirement: "A viewer sees the fleet but not its mission capability, its parts or its crew.",
    run: async (api) => {
      const p = await api.call(PLANNER, "GET", "/api/objects/ops.Aircraft/AF86-0147");
      expectStatus(p, 200, "planner reads AF86-0147");
      if (p.body?.values?.missionCapability !== "partial") fail(`planner should read missionCapability "partial", got ${show(p)}`);
      const v = await api.call(VIEWER, "GET", "/api/objects/ops.Aircraft/AF86-0147");
      expectStatus(v, 200, "viewer reads AF86-0147");
      const vals = v.body?.values ?? {};
      if (vals.tailNumber !== "AF86-0147" || vals.mds !== "F-16C" || vals.unit !== "388FW" || vals.base !== "KHIF") fail(`viewer should see tailNumber, mds, unit and base, got ${show(v)}`);
      if ("missionCapability" in vals) fail(`missionCapability must be absent for a viewer, got ${show(v)}`);
    }
  },
  {
    id: "sc-viewer-query-fleet",
    requirement: "A viewer sees the fleet but not its mission capability, its parts or its crew.",
    run: async (api) => {
      const items = await query(api, VIEWER, "ops.Aircraft");
      const ids = items.map((i) => i.objectId).sort();
      const want = ["AF09-4126", "AF12-5052", "AF86-0147", "AF87-0212", "AF88-0405"];
      if (JSON.stringify(ids) !== JSON.stringify(want)) fail(`viewer should see the whole fleet ${JSON.stringify(want)}, got ${JSON.stringify(ids)}`);
      for (const i of items) {
        if (!i.values?.mds) fail(`aircraft values missing mds: ${JSON.stringify(i)}`);
        if ("missionCapability" in i.values) fail(`missionCapability must be absent for a viewer: ${JSON.stringify(i)}`);
      }
    }
  },
  {
    id: "sc-viewer-no-parts-no-crew",
    requirement: "A viewer sees the fleet but not its mission capability, its parts or its crew.",
    run: async (api) => {
      expectStatus(await api.call(VIEWER, "GET", "/api/objects/ops.Requisition/KHIF-6281-0001"), 403, "viewer reads requisition KHIF-6281-0001");
      expectStatus(await api.call(VIEWER, "GET", "/api/objects/ops.CrewMember/C-1001"), 403, "viewer reads crew member C-1001");
      // Contract: a query answers 403 when the caller may read no object of that Type at all.
      expectStatus(await api.call(VIEWER, "POST", "/api/query", { type: "ops.Requisition" }), 403, "viewer queries ops.Requisition");
      expectStatus(await api.call(VIEWER, "POST", "/api/query", { type: "ops.CrewMember" }), 403, "viewer queries ops.CrewMember");
    }
  },
  {
    id: "sc-planner-reads-three-services",
    requirement: "The aircraft comes from the fleet registry, its crew from the crew roster and its parts from the parts depot",
    run: async (api) => {
      const crew = await query(api, PLANNER, "ops.CrewMember", { property: "assignedTail", operator: "eq", value: "AF86-0147" });
      const crewIds = crew.map((i) => i.objectId).sort();
      if (JSON.stringify(crewIds) !== JSON.stringify(["C-1001", "C-1002"])) fail(`AF86-0147's crew should be C-1001 and C-1002, got ${JSON.stringify(crewIds)}`);
      const parts = await query(api, PLANNER, "ops.Requisition", { property: "tailNumber", operator: "eq", value: "AF86-0147" });
      const partIds = parts.map((i) => i.objectId).sort();
      if (JSON.stringify(partIds) !== JSON.stringify(["KHIF-6281-0001", "KHIF-6281-0002"])) fail(`AF86-0147's requisitions should be KHIF-6281-0001 and KHIF-6281-0002, got ${JSON.stringify(partIds)}`);
      const r = await api.call(PLANNER, "GET", "/api/objects/ops.Requisition/KHIF-6281-0001");
      expectStatus(r, 200, "planner reads KHIF-6281-0001");
      if (r.body?.values?.nomenclature !== "Radar processor" || r.body?.values?.status !== "in-transit") fail(`KHIF-6281-0001 should be the in-transit Radar processor, got ${show(r)}`);
    }
  },
  {
    id: "sc-planner-sees-own-unit-name",
    requirement: "A crew member's name is shown only to a planner of that crew member's unit.",
    run: async (api) => {
      const res = await api.call(PLANNER, "GET", "/api/objects/ops.CrewMember/C-1001");
      expectStatus(res, 200, "388FW planner reads C-1001 (388FW)");
      const v = res.body?.values ?? {};
      if (v.callsign !== "VIPER") fail(`C-1001 callsign should be VIPER, got ${show(res)}`);
      if (v.name !== "Capt Dana Reyes") fail(`a 388FW planner should see C-1001's name "Capt Dana Reyes", got ${show(res)}`);
    }
  },
  {
    id: "sc-planner-other-unit-no-name",
    requirement: "A crew member's name is shown only to a planner of that crew member's unit.",
    run: async (api) => {
      const res = await api.call(PLANNER, "GET", "/api/objects/ops.CrewMember/C-2001");
      expectStatus(res, 200, "388FW planner reads C-2001 (419FW)");
      const v = res.body?.values ?? {};
      if (v.callsign !== "GHOST" || v.unit !== "419FW") fail(`C-2001 should be GHOST of 419FW, got ${show(res)}`);
      if ("name" in v) fail(`a 388FW planner must not see a 419FW crew member's name, got ${show(res)}`);
      const all = await query(api, PLANNER, "ops.CrewMember");
      const ghost = all.find((i) => i.objectId === "C-2001");
      if (!ghost) fail(`planner's crew query should include C-2001, got ${JSON.stringify(all.map((i) => i.objectId))}`);
      if ("name" in (ghost.values ?? {})) fail(`name of C-2001 must be absent from the planner's query too: ${JSON.stringify(ghost)}`);
      const viper = all.find((i) => i.objectId === "C-1001");
      if (viper?.values?.name !== "Capt Dana Reyes") fail(`planner's query should show C-1001's name: ${JSON.stringify(viper)}`);
    }
  },
  {
    id: "sc-maintainer-no-crew-name",
    requirement: "A crew member's name is shown only to a planner of that crew member's unit.",
    run: async (api) => {
      // TSgt Ruiz is of 388FW like C-1001, but is not a planner.
      const res = await api.call(MAINTAINER, "GET", "/api/objects/ops.CrewMember/C-1001");
      expectStatus(res, 200, "maintainer reads C-1001");
      const v = res.body?.values ?? {};
      if (v.callsign !== "VIPER") fail(`maintainer should see C-1001's callsign VIPER, got ${show(res)}`);
      if ("name" in v) fail(`a maintainer must not see a crew member's name, got ${show(res)}`);
      const all = await query(api, MAINTAINER, "ops.CrewMember");
      if (all.length === 0) fail("maintainer's crew query should not be empty");
      for (const i of all) if ("name" in (i.values ?? {})) fail(`name must be absent for a maintainer: ${JSON.stringify(i)}`);
    }
  }
  // ambiguous: the requirement does not say whether a pilot on leave (C-1003 RAVEN, AF87-0212) may be
  // confirmed, nor whether a 388FW planner may sign off a 419FW aircraft's pilot (AF09-4126 / C-2001);
  // both are untested.
  // ambiguous: a pilotId or tailNumber that does not exist is not specified (failed run or 404); untested.
  // ambiguous: this requirement, unlike the other two, has no sentence saying someone not signed in
  // sees nothing; reads by anonymous are left untested here (starting and signing off are tested via ops.crew/ops.sortie-signoff).
];
