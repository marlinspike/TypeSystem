// Hidden acceptance tests: Recall response (cold chain host + the recall exchange).
// Data, as seeded by the four services:
//   RCL-26-0412 Northwind COVID-19 mRNA, NDC 80777027310, class II, public, active, awaiting.
//     Lists L-7701 (ours: 1200 doses, available at CHI, SH-1040 delivered), L-7731 (ours: 1500 doses,
//     in-transit on SH-1042, tracker in transit) and L-7795 (not ours). L-7732 rides SH-1042 but is not listed.
//   RCL-26-0388 Helix insulin glargine, class I, EMBARGOED: L-7740 (600 doses, SH-1044 in transit).
//   RCL-26-0405 Cascadia RSV, NDC 58160084811: L-7745 (ours, RSV, matches) and L-7720 (ours, but influenza
//     49281-0424-50): the NDC does not match, so the request fails.
//   RCL-26-0420 Helix MMR: L-7770 (700 doses, inventory in-transit, but SH-1048 is held in the tracker).
//   RCL-26-0360 Cascadia zoster: a response is already on file (0 doses, signed off by Dr. Priya Raman).
//   RCL-25-0990 Northwind adalimumab: terminated by the manufacturer.

const LOGISTICS = "demo-logistics-token"; // Dana Whitfield
const QA = "demo-qa-token"; // Dr. Priya Raman
const QA2 = "demo-qa2-token"; // Dr. Tomasz Brandt
const AUDITOR = "demo-auditor-token"; // Sam Ortega
const CARRIER = "demo-carrier-token"; // Northline dispatch
const ANON = "";
const WF = "/api/workflows/coldchain.RespondToRecall/runs";
const STEP = "qaSignoff";

function fail(msg) {
  throw new Error(msg);
}
function show(res) {
  return `${res.status} ${JSON.stringify(res.body)}`;
}
function expectStatus(res, code, what) {
  if (res.status !== code) fail(`${what}: expected HTTP ${code}, got ${show(res)}`);
}
const sorted = (v) => (Array.isArray(v) ? [...v].map(String).sort() : v);
function expectSet(actual, expected, what) {
  if (JSON.stringify(sorted(actual)) !== JSON.stringify([...expected].sort())) fail(`${what}: expected ${JSON.stringify(expected)} (any order), got ${JSON.stringify(actual)}`);
}

/**
 * A refusal means something only where the application grants what it
 * should: a caller allowed to read must read. Every negative check starts
 * here, so an application that refuses everything passes none.
 */
async function expectServing(api) {
  const res = await api.call(LOGISTICS, "GET", "/api/objects/coldchain.Recall/RCL-26-0412");
  expectStatus(res, 200, "logistics reads RCL-26-0412 (a refusal below means something only if this is allowed)");
  if (res.body?.values?.firm !== "Northwind Biologics") fail(`RCL-26-0412 should be from Northwind Biologics, got ${show(res)}`);
}
async function readRecall(api, token, id) {
  const res = await api.call(token, "GET", `/api/objects/coldchain.Recall/${id}`);
  expectStatus(res, 200, `read coldchain.Recall ${id}`);
  return res.body?.values ?? {};
}
async function lotStatus(api, id) {
  const res = await api.call(LOGISTICS, "GET", `/api/objects/coldchain.Lot/${id}`);
  expectStatus(res, 200, `logistics reads lot ${id}`);
  return res.body?.values ?? {};
}
async function expectLot(api, id, status, what) {
  const v = await lotStatus(api, id);
  if (v.status !== status) fail(`${what}: lot ${id} should be ${status}, got ${JSON.stringify(v)}`);
  return v;
}
function start(api, token, recallId) {
  return api.call(token, "POST", WF, { input: { recallId } });
}
async function startWaiting(api, token, recallId) {
  const res = await start(api, token, recallId);
  expectStatus(res, 201, `start coldchain.RespondToRecall for ${recallId}`);
  if (res.body?.status !== "waiting-approval") fail(`expected run status "waiting-approval", got ${show(res)}`);
  if (res.body?.waitingOn?.step !== STEP) fail(`expected waitingOn.step "${STEP}", got ${show(res)}`);
  if (typeof res.body?.runId !== "string" || !res.body.runId) fail(`expected a runId, got ${show(res)}`);
  return res.body.runId;
}
function approve(api, token, runId) {
  return api.call(token, "POST", `/api/workflow-runs/${encodeURIComponent(runId)}/approvals/${STEP}`, { approved: true });
}
async function approveCompleted(api, token, runId, what) {
  const ap = await approve(api, token, runId);
  expectStatus(ap, 200, what);
  if (ap.body?.status !== "completed") fail(`${what}: the run should be completed, got ${show(ap)}`);
}
async function runStatus(api, token, runId) {
  const got = await api.call(token, "GET", `/api/workflow-runs/${encodeURIComponent(runId)}`);
  expectStatus(got, 200, "read the run");
  return got.body?.status;
}
async function expectFailedRun(api, token, recallId, what) {
  const res = await start(api, token, recallId);
  expectStatus(res, 201, what);
  if (res.body?.status !== "failed") fail(`${what}: expected status "failed", got ${show(res)}`);
  if (res.body?.waitingOn) fail(`${what}: a failed run never waits for approval, got ${show(res)}`);
}
async function queryIds(api, token, type) {
  const res = await api.call(token, "POST", "/api/query", { type });
  expectStatus(res, 200, `query ${type}`);
  if (!Array.isArray(res.body?.items)) fail(`query ${type}: expected items, got ${show(res)}`);
  return res.body.items.map((i) => i.objectId);
}

export default [
  {
    id: "rr-coordinator-asks",
    requirement: "A logistics coordinator or a quality assurance pharmacist asks to respond to a notice. Quality assurance signs the response off.",
    run: async (api) => {
      const runId = await startWaiting(api, LOGISTICS, "RCL-26-0412");
      if ((await runStatus(api, LOGISTICS, runId)) !== "waiting-approval") fail("the coordinator who asked should read the run as waiting-approval");
      // Contract: a run reads back to its starter and to anyone who may approve the step it waits on; 404 to anyone else.
      if ((await runStatus(api, QA, runId)) !== "waiting-approval") fail("Dr. Raman (who may sign off) should read the run as waiting-approval");
      if ((await runStatus(api, QA2, runId)) !== "waiting-approval") fail("Dr. Brandt (who may sign off) should read the run as waiting-approval");
      expectStatus(await api.call(AUDITOR, "GET", `/api/workflow-runs/${encodeURIComponent(runId)}`), 404, "the auditor (neither asker nor approver) reads the run");
      expectStatus(await api.call(CARRIER, "GET", `/api/workflow-runs/${encodeURIComponent(runId)}`), 404, "the carrier reads the run");
    }
  },
  {
    id: "rr-nothing-before-signoff",
    requirement: "Only once it is signed off are our affected lots quarantined in the pharmacy inventory and our response filed with the exchange; nothing is held, and nothing is sent to the manufacturer, before that.",
    run: async (api) => {
      const before = await readRecall(api, QA, "RCL-26-0412");
      if (before.responseStatus !== "awaiting") fail(`RCL-26-0412 should start awaiting, got ${JSON.stringify(before)}`);
      const runId = await startWaiting(api, LOGISTICS, "RCL-26-0412");
      await expectLot(api, "L-7701", "available", "before sign-off");
      await expectLot(api, "L-7731", "in-transit", "before sign-off");
      const after = await readRecall(api, QA, "RCL-26-0412");
      if (after.responseStatus !== "awaiting") fail(`no response may be filed before sign-off, got ${JSON.stringify(after)}`);
      if ((await runStatus(api, LOGISTICS, runId)) !== "waiting-approval") fail("the run should still be waiting-approval");
    }
  },
  {
    id: "rr-signoff-quarantines-listed-lots",
    requirement: "Our affected lots are every lot the notice lists that is in the pharmacy inventory and not destroyed. Each is quarantined in the pharmacy inventory with a hold reason that contains the recall number. A lot the notice does not list stays as it is, even on the same shipment.",
    run: async (api) => {
      const runId = await startWaiting(api, LOGISTICS, "RCL-26-0412");
      await approveCompleted(api, QA, runId, "Dr. Raman signs off the coordinator's response");
      for (const id of ["L-7701", "L-7731"]) {
        const v = await expectLot(api, id, "quarantined", "after sign-off");
        if (typeof v.holdReason !== "string" || !v.holdReason.includes("RCL-26-0412")) fail(`lot ${id}'s hold reason should name RCL-26-0412, got ${JSON.stringify(v)}`);
      }
      await expectLot(api, "L-7732", "in-transit", "a lot on SH-1042 the notice does not list");
      await expectLot(api, "L-7720", "available", "an unrelated lot");
      if ((await runStatus(api, LOGISTICS, runId)) !== "completed") fail("the run should read back completed");
    }
  },
  {
    id: "rr-response-filed-across-systems",
    requirement: "The response filed with the exchange gives those lot numbers, the sum of their doses, the references of the shipments carrying one of them that the shipment tracker shows as in transit.",
    run: async (api) => {
      const runId = await startWaiting(api, LOGISTICS, "RCL-26-0412");
      await approveCompleted(api, QA2, runId, "Dr. Brandt signs off the coordinator's response");
      for (const token of [QA, LOGISTICS]) {
        const v = await readRecall(api, token, "RCL-26-0412");
        if (v.responseStatus !== "responded") fail(`RCL-26-0412 should be responded, got ${JSON.stringify(v)}`);
        expectSet(v.lotsHeld, ["L-7701", "L-7731"], "lotsHeld (L-7795 is not ours)");
        if (v.dosesHeld !== 2700) fail(`dosesHeld should be 1200 + 1500 = 2700, got ${JSON.stringify(v.dosesHeld)}`);
        expectSet(v.shipmentsInTransit, ["SH-1042"], "shipmentsInTransit (SH-1040 was delivered)");
      }
    }
  },
  {
    id: "rr-tracker-decides-in-transit",
    requirement: "the references of the shipments carrying one of them that the shipment tracker shows as in transit (a delivered or held shipment is not in transit, whatever the inventory says of the lot)",
    run: async (api) => {
      await expectLot(api, "L-7770", "in-transit", "the inventory's own view of L-7770");
      const runId = await startWaiting(api, LOGISTICS, "RCL-26-0420");
      await approveCompleted(api, QA, runId, "Dr. Raman signs off RCL-26-0420");
      await expectLot(api, "L-7770", "quarantined", "after sign-off");
      const v = await readRecall(api, AUDITOR, "RCL-26-0420");
      if (v.responseStatus !== "responded") fail(`RCL-26-0420 should be responded, got ${JSON.stringify(v)}`);
      expectSet(v.lotsHeld, ["L-7770"], "lotsHeld");
      if (v.dosesHeld !== 700) fail(`dosesHeld should be 700, got ${JSON.stringify(v.dosesHeld)}`);
      expectSet(v.shipmentsInTransit, [], "shipmentsInTransit (SH-1048 is held in the tracker)");
    }
  },
  {
    id: "rr-qa-never-signs-own",
    requirement: "Quality assurance signs the response off, and never the person who asked for it.",
    run: async (api) => {
      const runId = await startWaiting(api, QA, "RCL-26-0412");
      expectStatus(await approve(api, QA, runId), 403, "Dr. Raman signs off a response she asked for herself");
      if ((await runStatus(api, QA, runId)) !== "waiting-approval") fail("the run should still be waiting-approval");
      await expectLot(api, "L-7731", "in-transit", "after a refused self sign-off");
      if ((await readRecall(api, QA, "RCL-26-0412")).responseStatus !== "awaiting") fail("no response may be filed after a refused self sign-off");
      await approveCompleted(api, QA2, runId, "Dr. Brandt signs off Dr. Raman's response");
      await expectLot(api, "L-7731", "quarantined", "after Dr. Brandt's sign-off");
    }
  },
  {
    id: "rr-no-one-else-approves",
    requirement: "Only quality assurance signs off, and never for a response they asked for themselves. No one else may approve, whoever asked.",
    run: async (api) => {
      const runId = await startWaiting(api, LOGISTICS, "RCL-26-0412");
      expectStatus(await approve(api, LOGISTICS, runId), 403, "the coordinator approves her own request");
      expectStatus(await approve(api, AUDITOR, runId), 403, "the auditor approves");
      expectStatus(await approve(api, CARRIER, runId), 403, "the carrier approves");
      expectStatus(await approve(api, ANON, runId), 403, "someone not signed in approves");
      if ((await runStatus(api, LOGISTICS, runId)) !== "waiting-approval") fail("the run should still be waiting-approval");
      await expectLot(api, "L-7701", "available", "after refused approvals");
      const qaRun = await startWaiting(api, QA, "RCL-26-0420");
      expectStatus(await approve(api, LOGISTICS, qaRun), 403, "the coordinator approves Dr. Raman's request");
      if ((await runStatus(api, QA, qaRun)) !== "waiting-approval") fail("Dr. Raman's run should still be waiting-approval");
    }
  },
  {
    id: "rr-embargo-need-to-know",
    requirement: "A notice still under embargo is need-to-know for quality assurance alone: no one else reads it, finds it in a query, or may ask to respond to it.",
    run: async (api) => {
      const v = await readRecall(api, QA, "RCL-26-0388");
      if (v.embargoed !== true || v.recallClass !== "I") fail(`RCL-26-0388 should read embargoed, class I, got ${JSON.stringify(v)}`);
      if (!(await queryIds(api, QA, "coldchain.Recall")).includes("RCL-26-0388")) fail("quality assurance should find RCL-26-0388 in a query");
      for (const token of [LOGISTICS, AUDITOR]) {
        expectStatus(await api.call(token, "GET", "/api/objects/coldchain.Recall/RCL-26-0388"), 403, `${token} reads embargoed RCL-26-0388`);
        const ids = await queryIds(api, token, "coldchain.Recall");
        if (!ids.includes("RCL-26-0412")) fail(`${token} should find public RCL-26-0412 in a query, got ${JSON.stringify(ids)}`);
        if (ids.includes("RCL-26-0388")) fail(`${token} must not find embargoed RCL-26-0388 in a query, got ${JSON.stringify(ids)}`);
      }
      expectStatus(await start(api, LOGISTICS, "RCL-26-0388"), 403, "the coordinator asks to respond to embargoed RCL-26-0388");
    }
  },
  {
    id: "rr-embargoed-response-by-qa",
    requirement: "Quality assurance reads every notice ... the display name of the quality assurance person who signed it off.",
    run: async (api) => {
      const runId = await startWaiting(api, QA, "RCL-26-0388");
      await expectLot(api, "L-7740", "in-transit", "before sign-off");
      await approveCompleted(api, QA2, runId, "Dr. Brandt signs off Dr. Raman's response to RCL-26-0388");
      const lot = await expectLot(api, "L-7740", "quarantined", "after sign-off");
      if (typeof lot.holdReason !== "string" || !lot.holdReason.includes("RCL-26-0388")) fail(`L-7740's hold reason should name RCL-26-0388, got ${JSON.stringify(lot)}`);
      const v = await readRecall(api, QA, "RCL-26-0388");
      if (v.responseStatus !== "responded") fail(`RCL-26-0388 should be responded, got ${JSON.stringify(v)}`);
      expectSet(v.lotsHeld, ["L-7740"], "lotsHeld");
      if (v.dosesHeld !== 600) fail(`dosesHeld should be 600, got ${JSON.stringify(v.dosesHeld)}`);
      expectSet(v.shipmentsInTransit, ["SH-1044"], "shipmentsInTransit");
      if (v.signedOffBy !== "Dr. Tomasz Brandt") fail(`signedOffBy should be the approver, Dr. Tomasz Brandt, got ${JSON.stringify(v.signedOffBy)}`);
    }
  },
  {
    id: "rr-health-hazard-confidential",
    requirement: "The health hazard evaluation is confidential: only quality assurance reads it. Everyone else who reads a notice reads it without that field.",
    run: async (api) => {
      for (const token of [QA, QA2]) {
        const v = await readRecall(api, token, "RCL-26-0412");
        if (typeof v.healthHazard !== "string" || !v.healthHazard.includes("potency")) fail(`quality assurance should read RCL-26-0412's health hazard evaluation, got ${JSON.stringify(v)}`);
      }
      for (const token of [LOGISTICS, AUDITOR]) {
        const v = await readRecall(api, token, "RCL-26-0412");
        if (v.recallClass !== "II" || v.firm !== "Northwind Biologics" || v.lifecycle !== "active" || v.embargoed !== false) fail(`${token} should read RCL-26-0412 (class II, Northwind, active, public), got ${JSON.stringify(v)}`);
        if ("healthHazard" in v) fail(`${token} must not read healthHazard, got ${JSON.stringify(v)}`);
        const q = await api.call(token, "POST", "/api/query", { type: "coldchain.Recall" });
        expectStatus(q, 200, `${token} queries coldchain.Recall`);
        for (const item of q.body?.items ?? []) if (item?.values && "healthHazard" in item.values) fail(`${token}'s query must not carry healthHazard, got ${JSON.stringify(item)}`);
      }
    }
  },
  {
    id: "rr-auditor-and-carrier-cannot-ask",
    requirement: "A logistics coordinator and quality assurance may ask to respond; the auditor and a carrier may not.",
    run: async (api) => {
      await expectServing(api);
      expectStatus(await start(api, AUDITOR, "RCL-26-0412"), 403, "the auditor asks to respond");
      expectStatus(await start(api, CARRIER, "RCL-26-0412"), 403, "the carrier asks to respond");
      expectStatus(await start(api, ANON, "RCL-26-0412"), 403, "someone not signed in asks to respond");
      await expectLot(api, "L-7701", "available", "after refused requests");
    }
  },
  {
    id: "rr-carrier-and-anonymous-read-no-notice",
    requirement: "A carrier's dispatcher reads no notice. Someone not signed in sees nothing and may do nothing.",
    run: async (api) => {
      await expectServing(api);
      for (const [token, who] of [[CARRIER, "the carrier"], [ANON, "someone not signed in"]]) {
        for (const id of ["RCL-26-0412", "RCL-26-0388"]) expectStatus(await api.call(token, "GET", `/api/objects/coldchain.Recall/${id}`), 403, `${who} reads ${id}`);
        // Contract: a query answers 403 when the caller may read no object of that Type at all.
        expectStatus(await api.call(token, "POST", "/api/query", { type: "coldchain.Recall" }), 403, `${who} queries coldchain.Recall`);
      }
    }
  },
  {
    id: "rr-terminated-fails",
    requirement: "A notice the manufacturer has terminated ... cannot be answered: the request fails, and nothing changes anywhere.",
    run: async (api) => {
      const v = await readRecall(api, LOGISTICS, "RCL-25-0990");
      if (v.lifecycle !== "terminated") fail(`RCL-25-0990 should read terminated, got ${JSON.stringify(v)}`);
      await expectFailedRun(api, LOGISTICS, "RCL-25-0990", "respond to terminated RCL-25-0990");
      await expectLot(api, "L-7751", "in-transit", "after the failed request");
    }
  },
  {
    id: "rr-already-answered-fails",
    requirement: "a notice we have already answered ... cannot be answered: the request fails, and nothing changes anywhere.",
    run: async (api) => {
      const v = await readRecall(api, QA, "RCL-26-0360");
      if (v.responseStatus !== "responded" || v.dosesHeld !== 0 || v.signedOffBy !== "Dr. Priya Raman") fail(`RCL-26-0360 should read responded (0 doses, signed off by Dr. Priya Raman), got ${JSON.stringify(v)}`);
      await expectFailedRun(api, QA, "RCL-26-0360", "respond to already-answered RCL-26-0360");
      await expectLot(api, "L-7760", "in-transit", "after the failed request");
    }
  },
  {
    id: "rr-second-response-fails",
    requirement: "a notice we have already answered ... cannot be answered: the request fails",
    run: async (api) => {
      const runId = await startWaiting(api, LOGISTICS, "RCL-26-0420");
      await approveCompleted(api, QA, runId, "Dr. Raman signs off RCL-26-0420");
      await expectFailedRun(api, LOGISTICS, "RCL-26-0420", "respond again to RCL-26-0420 once answered");
    }
  },
  {
    id: "rr-ndc-mismatch-fails",
    requirement: "If any lot it lists is in our inventory with a different NDC, the notice does not describe our stock and the request fails.",
    run: async (api) => {
      const v = await readRecall(api, LOGISTICS, "RCL-26-0405");
      if (v.responseStatus !== "awaiting" || v.lifecycle !== "active") fail(`RCL-26-0405 should be active and awaiting, got ${JSON.stringify(v)}`);
      await expectFailedRun(api, LOGISTICS, "RCL-26-0405", "respond to RCL-26-0405, which lists influenza lot L-7720 under the RSV NDC");
      await expectLot(api, "L-7745", "in-transit", "after the failed request (L-7745 matches, but nothing may change)");
      await expectLot(api, "L-7720", "available", "after the failed request");
      if ((await readRecall(api, LOGISTICS, "RCL-26-0405")).responseStatus !== "awaiting") fail("no response may be filed for a failed request");
    }
  }
  // ambiguous: a recallId the exchange does not know (failed run, 403 or 404) is not specified; untested.
  // ambiguous: whether lotsHeld, dosesHeld, shipmentsInTransit and signedOffBy are absent or null before a
  // response is on file is not specified; only their values after a response are asserted.
  // ambiguous: whether the auditor or a carrier may read coldchain.Lot is the host's existing policy, not this
  // requirement; lots are read here only by the logistics coordinator.
];
