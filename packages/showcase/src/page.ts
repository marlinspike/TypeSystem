/**
 * The guide's one page. Everything on it comes from /api/catalog and the
 * live endpoints, so the page and `docs/showcase/coverage.md` say the same
 * thing. Links are built from the host the page was opened on, so the guide
 * works through a forwarded port as well as on localhost.
 */
export function guidePage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TypeSystem Showcase</title>
<style>
:root { --bg:#f6f7f9; --panel:#fff; --ink:#15181d; --muted:#5b6370; --line:#dde1e7; --accent:#2457d6; --good:#1a7f4b; --bad:#b42318; --warn:#9a6700; --code:#eef1f5; }
@media (prefers-color-scheme: dark) { :root { --bg:#0f1216; --panel:#171b21; --ink:#e7eaee; --muted:#9aa3ae; --line:#2a3039; --accent:#7aa2ff; --good:#4cc38a; --bad:#ff7b72; --warn:#e3b341; --code:#1f252d; } }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
header { padding:28px 24px 8px; max-width:1180px; margin:0 auto; }
h1 { margin:0 0 6px; font-size:26px; letter-spacing:-0.01em; }
h2 { font-size:19px; margin:0 0 8px; }
h3 { font-size:14px; margin:14px 0 6px; color:var(--muted); text-transform:uppercase; letter-spacing:.04em; }
main { max-width:1180px; margin:0 auto; padding:0 24px 64px; }
p { margin:0 0 10px; }
a { color:var(--accent); }
.lede { color:var(--muted); max-width:860px; }
.grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(260px, 1fr)); gap:12px; margin:16px 0 24px; }
.card { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:14px 16px; }
.card .t { font-weight:600; display:flex; align-items:center; gap:8px; }
.dot { width:9px; height:9px; border-radius:50%; background:var(--line); display:inline-block; flex:none; }
.dot.up { background:var(--good); } .dot.down { background:var(--bad); }
.small { font-size:13px; color:var(--muted); }
.stages { display:flex; flex-wrap:wrap; gap:8px; margin:8px 0 28px; }
.stage { background:var(--panel); border:1px solid var(--line); border-radius:999px; padding:6px 12px; font-size:13px; }
.stage b { color:var(--accent); margin-right:4px; }
section.q { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:20px 22px; margin:16px 0; }
section.q .n { color:var(--accent); font-weight:700; margin-right:8px; }
.links a { display:inline-block; margin:2px 12px 2px 0; }
pre { background:var(--code); border-radius:8px; padding:8px 10px; margin:4px 0; overflow:auto; font:12.5px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; white-space:pre-wrap; word-break:break-word; }
code { font:12.5px ui-monospace, SFMono-Regular, Menlo, monospace; background:var(--code); padding:1px 5px; border-radius:4px; }
.cols { display:grid; grid-template-columns:1fr 1fr; gap:18px; }
@media (max-width: 800px) { .cols { grid-template-columns:1fr; } header, main { padding-left:16px; padding-right:16px; } }
.limits { border-left:3px solid var(--warn); padding:4px 10px; color:var(--muted); font-size:13px; margin-top:10px; }
.live { margin-top:14px; border-top:1px dashed var(--line); padding-top:12px; }
button, select { font:inherit; border:1px solid var(--line); background:var(--panel); color:var(--ink); border-radius:8px; padding:6px 12px; cursor:pointer; }
button.primary { background:var(--accent); color:#fff; border-color:var(--accent); }
button:disabled { opacity:.55; cursor:progress; }
table { border-collapse:collapse; width:100%; font-size:13.5px; margin-top:8px; }
th, td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
.ok { color:var(--good); font-weight:600; } .no { color:var(--bad); font-weight:600; }
.tag { display:inline-block; font-size:11.5px; padding:1px 7px; border-radius:999px; border:1px solid var(--line); margin-left:6px; }
.tag.sim { color:var(--warn); border-color:var(--warn); } .tag.real { color:var(--bad); border-color:var(--bad); }
footer { color:var(--muted); font-size:13px; margin-top:32px; }
</style>
</head>
<body>
<header>
  <h1>TypeSystem Showcase</h1>
  <p class="lede">One governed runtime over systems it did not write. Everything below is running on this machine: four independent services, the runtime demo, Studio over two domains, and two applications compiled from <code>app.json</code>. Each question is answered on a live surface, with the command and MCP tool that answer it without a browser. The identities are demonstration tokens, and the classification scheme is a demonstration one; nothing here is an accredited security configuration.</p>
</header>
<main>
  <div id="surfaces" class="grid"></div>
  <div class="stages" id="stages"></div>
  <div id="questions"></div>
  <footer>Reset restarts every service and application with its first data. The guide listens on loopback only. Source: <code>packages/showcase</code>; coverage matrix: <code>docs/showcase/coverage.md</code>.</footer>
</main>
<script>
const host = location.hostname;
const at = (port, path) => location.protocol + "//" + host + ":" + port + (path || "/");
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[c]));
const j = async (url, init) => { const r = await fetch(url, init); return r.json(); };
let catalog;

async function render() {
  catalog = await j("/api/catalog");
  const s = catalog.surfaces;
  document.getElementById("surfaces").innerHTML = Object.entries(s).filter(([k]) => k !== "guide").map(([k, v]) =>
    '<div class="card"><div class="t"><span class="dot" id="dot-' + k + '"></span><a target="_blank" rel="noopener" href="' + at(v.port) + '">' + esc(v.title) + '</a><span class="small">:' + v.port + '</span></div><div class="small">' + esc(v.what) + '</div></div>').join("");
  document.getElementById("stages").innerHTML = '<span class="small" style="align-self:center">The challenge, stage by stage:</span>' + catalog.stages.map((st) => '<span class="stage" title="' + esc(st.what) + '"><b>' + st.id + '</b>' + esc(st.title) + '</span>').join("");
  document.getElementById("questions").innerHTML = catalog.questions.map((q, i) => {
    const links = q.links.map((l) => '<a target="_blank" rel="noopener" href="' + at(s[l.surface].port, l.path) + '">' + esc(l.label) + '</a> <span class="small">(' + esc(s[l.surface].title) + ')</span>').join("<br>");
    const cli = q.cli.map((c) => "<pre>" + esc(c) + "</pre>").join("");
    const mcp = q.mcp.map((m) => '<div class="small">' + esc(m.server) + '</div><pre>' + esc(m.tools.join(", ")) + "</pre>").join("");
    return '<section class="q" id="' + q.id + '"><h2><span class="n">' + (i + 1) + '</span>' + esc(q.question) + '</h2><p>' + esc(q.answer) + '</p>' +
      '<div class="cols"><div><h3>See it</h3><div class="links">' + links + '</div><h3>Source</h3>' + q.sources.map((p) => "<code>" + esc(p) + "</code>").join(" ") + '</div><div><h3>From a terminal</h3>' + cli + '<h3>Over MCP</h3>' + mcp + '</div></div>' +
      (q.limits ? '<div class="limits">' + esc(q.limits) + '</div>' : "") + (q.live ? '<div class="live" id="live-' + q.live + '"></div>' : "") + '</section>';
  }).join("");
  livePanels();
  refresh();
  setInterval(refresh, 5000);
}

async function refresh() {
  const st = await j("/api/status");
  for (const [k, up] of Object.entries(st.surfaces)) { const d = document.getElementById("dot-" + k); if (d) d.className = "dot " + (up ? "up" : "down"); }
  const el = document.getElementById("svc-table");
  if (el) el.innerHTML = Object.entries(catalog.services).map(([k, v]) => {
    const up = st.services[k];
    return "<tr><td><span class='dot " + (up ? "up" : "down") + "'></span> " + esc(v.system) + "</td><td class='small'>" + esc(v.auth) + "</td><td class='small'>:" + v.port + "</td><td><button data-svc='" + k + "' data-down='" + (up ? "true" : "false") + "'>" + (up ? "Stop (outage)" : "Start") + "</button></td></tr>";
  }).join("");
  el && el.querySelectorAll("button[data-svc]").forEach((b) => b.onclick = async () => { b.disabled = true; await j("/api/outage", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ service: b.dataset.svc, down: b.dataset.down === "true" }) }); refresh(); });
}

function livePanels() {
  const sys = document.getElementById("live-systems");
  if (sys) sys.innerHTML = "<h3>Right now</h3><table><thead><tr><th>System</th><th>Authentication</th><th>Port</th><th></th></tr></thead><tbody id='svc-table'></tbody></table>";
  const out = document.getElementById("live-outage");
  if (out) out.innerHTML = "<h3>Try it</h3><p class='small'>Stop the pharmacy inventory, then open the shipment page above: the tracker's and the sensor hub's values are there, and the lots panel says the service could not answer. Start it again and reload.</p><button id='inv-down'>Stop the pharmacy inventory</button> <button id='inv-up'>Start it again</button> <button id='reset'>Reset everything</button> <span class='small' id='out-msg'></span><table><thead><tr><th>Read</th><th>From</th><th>Status</th><th>Answer</th></tr></thead><tbody id='probe-table'></tbody></table>";
  const post = (url, body) => j(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
  const showProbe = async () => {
    const t = document.getElementById("probe-table");
    if (!t) return;
    const p = await j("/api/probe");
    t.innerHTML = p.reads.map((r) => "<tr><td>" + esc(r.what) + "</td><td class='small'>" + esc(r.system) + "</td><td><span class='code " + (r.status < 300 ? "ok" : "no") + "'>" + r.status + "</span></td><td class='small'>" + esc(r.result) + "</td></tr>").join("");
  };
  if (out) {
    showProbe();
    document.getElementById("inv-down").onclick = async () => { await post("/api/outage", { service: "pharmacy-inventory", down: true }); document.getElementById("out-msg").textContent = "The pharmacy inventory is down."; refresh(); showProbe(); };
    document.getElementById("inv-up").onclick = async () => { await post("/api/outage", { service: "pharmacy-inventory", down: false }); document.getElementById("out-msg").textContent = "The pharmacy inventory is back."; refresh(); showProbe(); };
    document.getElementById("reset").onclick = async (e) => { e.target.disabled = true; document.getElementById("out-msg").textContent = "Restarting…"; await post("/api/reset"); e.target.disabled = false; document.getElementById("out-msg").textContent = "Everything is back to its first state."; refresh(); showProbe(); };
  }
  const cmp = document.getElementById("live-compare");
  if (cmp) {
    cmp.innerHTML = "<h3>Compare identities</h3><select id='cmp-read'><option value='embargoed'>Recall RCL-26-0388 (embargoed)</option><option value='public'>Recall RCL-26-0412 (public)</option><option value='lot'>Lot L-7731 (unit cost)</option><option value='shipment'>Shipment SH-1046 (another carrier)</option></select> <button class='primary' id='cmp-go'>Read as everyone</button><div id='cmp-out'></div>";
    document.getElementById("cmp-go").onclick = async () => {
      const r = await j("/api/compare?read=" + document.getElementById("cmp-read").value);
      const all = [...new Set(r.rows.flatMap((x) => x.fields || []))].sort();
      document.getElementById("cmp-out").innerHTML = "<p class='small'>" + esc(r.read.why) + " Read through the application's own API with each caller's token.</p><table><thead><tr><th>Caller</th><th>Answer</th><th>Fields returned</th><th>Not returned</th></tr></thead><tbody>" +
        r.rows.map((x) => "<tr><td><b>" + esc(x.as) + "</b><div class='small'>" + esc(x.who) + "</div></td><td class='" + (x.status === 200 ? "ok" : "no") + "'>" + (x.status || "error") + "</td><td>" + (x.fields ? esc(x.fields.join(", ")) : "<span class='small'>" + esc(x.error || "") + "</span>") + "</td><td class='small'>" + (x.fields ? esc(all.filter((f) => !x.fields.includes(f)).join(", ")) : "everything") + "</td></tr>").join("") + "</tbody></table>";
    };
  }
  const wf = document.getElementById("live-workflow");
  if (wf) {
    wf.innerHTML = "<h3>Walk it through the API</h3><p class='small'>Runs the recall response for RCL-26-0412 as each person in turn. A notice can be answered once: use Reset (under question 8) to run it again.</p><button class='primary' id='wf-go'>Run the recall response</button><div id='wf-out'></div>";
    document.getElementById("wf-go").onclick = async (e) => {
      e.target.disabled = true;
      const r = await post("/api/workflow", {});
      e.target.disabled = false;
      document.getElementById("wf-out").innerHTML = "<table><thead><tr><th>Who</th><th>Did</th><th>Answer</th><th>Result</th></tr></thead><tbody>" + r.steps.map((x) => "<tr><td>" + esc(x.who) + "</td><td>" + esc(x.did) + "</td><td class='" + (x.status < 300 ? "ok" : "no") + "'>" + x.status + "</td><td class='small'>" + esc(x.result) + "</td></tr>").join("") + "</tbody></table>";
    };
  }
  const md = document.getElementById("live-models");
  if (md) {
    md.innerHTML = "<h3>Runtime models (not Claude Code)</h3><div id='md-out' class='small'>…</div>";
    j("/api/models").then((r) => {
      document.getElementById("md-out").innerHTML = "<p>Cold Chain Command's <code>stability</code> role, as configured now (<code>" + esc(r.active) + "</code>) and in the sample configurations. Switch with <code>TYPESYS_LLM_CONFIG=&lt;file&gt; npm run showcase</code>; check one with <code>npm run showcase -- models &lt;file&gt; --discover</code>. The simulated endpoint has answered " + r.simulatedRequests + " assessment request" + (r.simulatedRequests === 1 ? "" : "s") + " so far; start an assessment in Cold Chain Command and reload.</p><table><thead><tr><th>Configuration</th><th>Providers</th><th>Model</th></tr></thead><tbody>" +
        r.views.map((v) => "<tr><td><code>" + esc(v.file) + "</code>" + (v.active ? " <b>active</b>" : "") + (v.error ? "" : "<span class='tag " + (v.simulated ? "sim" : "real") + "'>" + (v.simulated ? "simulated" : "real provider") + "</span>") + "</td><td>" + (v.error ? esc(v.error) : v.providers.map((p) => esc(p.kind + (p.baseUrl ? " " + p.baseUrl : "") + ", " + p.environment + (p.credential ? ", key in " + p.credential.env + (p.credential.set ? " (set)" : " (not set)") : ""))).join("<br>")) + "</td><td>" + (v.models ? v.models.map((m) => esc(m.model)).join(", ") : "") + "</td></tr>").join("") + "</tbody></table>";
    });
  }
}
render();
</script>
</body>
</html>`;
}
