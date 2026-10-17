// Drives the application through its API as each person in the requirement, a fresh server per scenario.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const T = { logistics: "demo-logistics-token", qa: "demo-qa-token", qa2: "demo-qa2-token", auditor: "demo-auditor-token", carrier: "demo-carrier-token", anon: undefined, bogus: "nope-token" };
let port = 4800;

async function server() {
  const p = port++;
  const child = spawn(process.execPath, [path.join(APP, "src/server.mjs")], { cwd: APP, env: { ...process.env, PORT: String(p) }, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", (c) => (log += c));
  child.stderr.on("data", (c) => (log += c));
  const base = `http://127.0.0.1:${p}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/api/me`)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  const call = async (who, method, url, body) => {
    const res = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(T[who] ? { authorization: `Bearer ${T[who]}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  };
  return { call, stop: () => child.kill(), log: () => log };
}

const lot = async (s, id) => (await s.call("qa", "GET", `/api/objects/coldchain.Lot/${id}`)).body.values;
const recall = async (s, id, who = "qa") => (await s.call(who, "GET", `/api/objects/coldchain.Recall/${id}`)).body.values;
const start = (s, who, recallId) => s.call(who, "POST", "/api/workflows/coldchain.RespondToRecall/runs", { input: { recallId } });
const approve = (s, who, runId) => s.call(who, "POST", `/api/workflow-runs/${runId}/approvals/qaSignoff`, { approved: true });

const scenarios = {
  async reads(s) {
    for (const who of ["qa", "qa2"]) {
      const r = await s.call(who, "GET", "/api/objects/coldchain.Recall/RCL-26-0388");
      assert.equal(r.status, 200);
      assert.ok(r.body.values.healthHazard);
      assert.equal(r.body.values.embargoed, true);
    }
    for (const who of ["logistics", "auditor"]) {
      const r = await s.call(who, "GET", "/api/objects/coldchain.Recall/RCL-26-0412");
      assert.equal(r.status, 200, who);
      assert.equal(r.body.values.healthHazard, undefined);
      assert.equal(r.body.values.firm, "Northwind Biologics");
      assert.equal(r.body.values.recallClass, "II");
      assert.equal((await s.call(who, "GET", "/api/objects/coldchain.Recall/RCL-26-0388")).status, 403, who);
      const q = await s.call(who, "POST", "/api/query", { type: "coldchain.Recall" });
      assert.equal(q.status, 200);
      assert.ok(!q.body.items.some((i) => i.objectId === "RCL-26-0388"));
      assert.ok(q.body.items.every((i) => i.values.healthHazard === undefined));
      assert.equal(q.body.items.length, 5);
      const f = await s.call(who, "POST", "/api/query", { type: "coldchain.Recall", filter: { property: "embargoed", operator: "eq", value: true } });
      assert.equal(f.status, 200);
      assert.equal(f.body.items.length, 0);
    }
    const qq = await s.call("qa", "POST", "/api/query", { type: "coldchain.Recall" });
    assert.equal(qq.body.items.length, 6);
    const done = await recall(s, "RCL-26-0360", "logistics");
    assert.equal(done.responseStatus, "responded");
    assert.deepEqual(done.lotsHeld, []);
    assert.equal(done.dosesHeld, 0);
    assert.equal(done.signedOffBy, "Dr. Priya Raman");
    for (const who of ["carrier", "anon", "bogus"]) {
      assert.equal((await s.call(who, "GET", "/api/objects/coldchain.Recall/RCL-26-0412")).status, 403, who);
      assert.equal((await s.call(who, "POST", "/api/query", { type: "coldchain.Recall" })).status, 403, who);
    }
    assert.equal((await s.call("qa", "GET", "/api/objects/coldchain.Recall/RCL-00-0000")).status, 404);
    assert.equal((await s.call("logistics", "GET", "/api/objects/coldchain.Recall/RCL-00-0000")).status, 404);
    const byFirm = await s.call("logistics", "POST", "/api/query", { type: "coldchain.Recall", filter: { property: "firm", operator: "eq", value: "Helix Pharma" } });
    assert.deepEqual(byFirm.body.items.map((i) => i.objectId), ["RCL-26-0420"]);
    const qaFirm = await s.call("qa", "POST", "/api/query", { type: "coldchain.Recall", filter: { property: "firm", operator: "eq", value: "Helix Pharma" } });
    assert.equal(qaFirm.body.items.length, 2);
    assert.equal((await s.call("anon", "GET", "/api/me")).status, 200);
  },
  async whoMayAsk(s) {
    for (const who of ["auditor", "carrier", "anon", "bogus"]) assert.equal((await start(s, who, "RCL-26-0412")).status, 403, who);
    assert.equal((await start(s, "logistics", "RCL-26-0388")).status, 403);
    for (const id of ["RCL-25-0990", "RCL-26-0360", "RCL-26-0405", "RCL-00-0000"]) {
      const r = await start(s, "logistics", id);
      assert.equal(r.status, 201, id);
      assert.equal(r.body.status, "failed", id);
      assert.equal(r.body.waitingOn, undefined);
    }
    assert.equal((await lot(s, "L-7745")).status, "in-transit");
    assert.equal((await lot(s, "L-7720")).status, "available");
    assert.equal((await recall(s, "RCL-26-0405")).responseStatus, "awaiting");
    assert.equal((await recall(s, "RCL-25-0990")).responseStatus, "awaiting");
  },
  async logisticsAsksQaSigns(s) {
    const r = await start(s, "logistics", "RCL-26-0412");
    assert.equal(r.status, 201);
    assert.equal(r.body.status, "waiting-approval");
    assert.equal(r.body.waitingOn.step, "qaSignoff");
    const runId = r.body.runId;
    // Nothing held, nothing filed, before sign-off.
    assert.equal((await lot(s, "L-7701")).status, "available");
    assert.equal((await recall(s, "RCL-26-0412")).responseStatus, "awaiting");
    for (const who of ["logistics", "auditor", "carrier", "anon"]) assert.equal((await approve(s, who, runId)).status, 403, who);
    // The bare Actions are refused outside a run.
    assert.equal((await s.call("logistics", "POST", "/api/actions/QuarantineRecallLots/invoke", { recallId: "RCL-26-0412", lotIds: ["L-7701"], reason: "x" })).status, 403);
    assert.equal((await s.call("qa", "POST", "/api/actions/FileRecallResponse/invoke", { recallId: "RCL-26-0412", lotsQuarantined: [], dosesQuarantined: 0, shipmentsInTransit: [], signedOffBy: "x" })).status, 403);
    assert.equal((await s.call("logistics", "GET", `/api/workflow-runs/${runId}`)).status, 200);
    assert.equal((await s.call("qa", "GET", `/api/workflow-runs/${runId}`)).status, 200);
    assert.equal((await s.call("auditor", "GET", `/api/workflow-runs/${runId}`)).status, 404);
    assert.equal((await s.call("carrier", "GET", `/api/workflow-runs/${runId}`)).status, 404);
    const a = await approve(s, "qa", runId);
    assert.equal(a.status, 200);
    assert.equal(a.body.status, "completed", JSON.stringify(a.body));
    assert.equal((await s.call("logistics", "GET", `/api/workflow-runs/${runId}`)).body.status, "completed");
    for (const id of ["L-7701", "L-7731"]) {
      const l = await lot(s, id);
      assert.equal(l.status, "quarantined", id);
      assert.ok(l.holdReason.includes("RCL-26-0412"), l.holdReason);
    }
    assert.equal((await lot(s, "L-7732")).status, "in-transit");
    const v = await recall(s, "RCL-26-0412", "logistics");
    assert.equal(v.responseStatus, "responded");
    assert.deepEqual(v.lotsHeld, ["L-7701", "L-7731"]);
    assert.equal(v.dosesHeld, 2700);
    assert.deepEqual(v.shipmentsInTransit, ["SH-1042"]);
    assert.equal(v.signedOffBy, "Dr. Priya Raman");
    const again = await start(s, "qa", "RCL-26-0412");
    assert.equal(again.body.status, "failed");
  },
  async qaAsksOtherQaSigns(s) {
    const r = await start(s, "qa", "RCL-26-0388");
    assert.equal(r.body.status, "waiting-approval");
    assert.equal((await approve(s, "qa", r.body.runId)).status, 403);
    assert.equal((await s.call("qa2", "GET", `/api/workflow-runs/${r.body.runId}`)).status, 200);
    const a = await approve(s, "qa2", r.body.runId);
    assert.equal(a.body.status, "completed");
    const v = await recall(s, "RCL-26-0388");
    assert.deepEqual(v.lotsHeld, ["L-7740"]);
    assert.equal(v.dosesHeld, 600);
    assert.deepEqual(v.shipmentsInTransit, ["SH-1044"]);
    assert.equal(v.signedOffBy, "Dr. Tomasz Brandt");
    // Held shipment: not in transit.
    const m = await start(s, "logistics", "RCL-26-0420");
    const b = await approve(s, "qa2", m.body.runId);
    assert.equal(b.body.status, "completed");
    const w = await recall(s, "RCL-26-0420");
    assert.deepEqual(w.lotsHeld, ["L-7770"]);
    assert.equal(w.dosesHeld, 700);
    assert.deepEqual(w.shipmentsInTransit, []);
    assert.equal((await lot(s, "L-7770")).status, "quarantined");
  },
  async twoRunsOneNotice(s) {
    const a = await start(s, "logistics", "RCL-26-0412");
    const b = await start(s, "logistics", "RCL-26-0412");
    assert.equal((await approve(s, "qa", a.body.runId)).body.status, "completed");
    const second = await approve(s, "qa2", b.body.runId);
    assert.notEqual(second.body.status, "completed");
    assert.equal((await lot(s, "L-7701")).status, "quarantined");
    assert.equal((await recall(s, "RCL-26-0412")).signedOffBy, "Dr. Priya Raman");
  }
};

let failed = 0;
for (const [name, run] of Object.entries(scenarios)) {
  const s = await server();
  try {
    await run(s);
    console.log(`ok   ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${name}: ${err.stack}\n${s.log()}`);
  } finally {
    s.stop();
  }
}
process.exit(failed ? 1 : 0);
