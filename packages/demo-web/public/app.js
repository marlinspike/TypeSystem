// TypeS demo — vanilla JS, no build step, no framework. Talks to the
// Express API in server.ts, which drives the exact same SemanticRuntime
// (and, via the MCP Console tab, the exact same MCP server) that the
// automated test suite exercises.

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  identity: "maintainer",
  types: [],
  typesByName: new Map(),
  breadcrumb: [], // [{typeName, objectId}]
  openRelationships: new Set() // relationship names currently expanded
};

const BROWSABLE_TYPES = ["airforce.Aircraft", "airforce.Component", "airforce.MaintenanceEvent", "airforce.WorkOrder"];

const IDENTITY_LABEL = { maintainer: "Maintainer", viewer: "Viewer", anonymous: "Anonymous" };
const IDENTITY_TOKEN = { maintainer: "demo-maintainer-token", viewer: "demo-viewer-token", anonymous: "" };

const READINESS_BADGE = {
  FMC: "badge-ok",
  PMC: "badge-warn",
  NMC: "badge-deny",
  UNKNOWN: "badge-warn"
};

// ---------------------------------------------------------------------------
// Tiny helpers
// ---------------------------------------------------------------------------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function prettyJson(value) {
  const json = JSON.stringify(value, null, 2);
  if (json === undefined) return "<span class=\"muted\">undefined</span>";
  let html = escapeHtml(json);
  html = html.replace(/(&quot;(?:[^"\\]|\\.)*&quot;)(:?)/g, (_m, str, colon) => `<span class="${colon ? "jk" : "js"}">${str}</span>${colon}`);
  html = html.replace(/: (-?\d+(?:\.\d+)?)/g, ': <span class="jn">$1</span>');
  html = html.replace(/: (true|false|null)/g, ': <span class="jb">$1</span>');
  return html;
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error((body && body.message) || res.statusText);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

function withIdentity(path) {
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}identity=${encodeURIComponent(state.identity)}`;
}

function friendlyLabel(values) {
  return values.name || values.tailNumber || values.description || values.eventType || values.status || values.id || "(unnamed)";
}

function relativeTime(iso) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const s = Math.round(diffMs / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return `${h}h ago`;
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
function initTabs() {
  $$(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      $$(".tab").forEach((b) => { b.classList.remove("active"); b.setAttribute("aria-selected", "false"); });
      btn.classList.add("active");
      btn.setAttribute("aria-selected", "true");
      $$(".tab-panel").forEach((p) => p.classList.remove("active"));
      $(`#tab-${btn.dataset.tab}`).classList.add("active");
    });
  });
}

// ---------------------------------------------------------------------------
// Identity switch
// ---------------------------------------------------------------------------
const IDENTITY_HINTS = {
  maintainer: "Acting as <strong>Maintainer</strong> — full read access, and authorized to invoke CreateMaintenanceWorkOrder.",
  viewer: "Acting as <strong>Viewer</strong> — can read Aircraft, but <code>maintenanceStatus</code> is policy-restricted and actions are denied. Reopen an Aircraft to see it.",
  anonymous: "Acting as <strong>Anonymous</strong> — no roles at all. Every object read is denied at the object level, not just per-property."
};

function initIdentitySwitch() {
  const container = $("#identitySwitch");
  container.innerHTML = Object.keys(IDENTITY_LABEL)
    .map(
      (key) => `<button class="identity-btn${key === state.identity ? " active" : ""}" data-key="${key}">
        <span class="identity-dot"></span>${IDENTITY_LABEL[key]}
      </button>`
    )
    .join("");

  container.addEventListener("click", (e) => {
    const btn = e.target.closest(".identity-btn");
    if (!btn) return;
    state.identity = btn.dataset.key;
    $$(".identity-btn", container).forEach((b) => b.classList.toggle("active", b.dataset.key === state.identity));
    $("#hintBanner").innerHTML = IDENTITY_HINTS[state.identity];
    $("#queryIdentityNote").textContent = state.identity;
    // Live re-evaluate whatever is currently on screen under the new identity.
    if (state.breadcrumb.length) renderCurrentObject();
    else renderActionsPanel(null);
  });

  $("#hintBanner").innerHTML = IDENTITY_HINTS[state.identity];
}

// ---------------------------------------------------------------------------
// Types panel + modal
// ---------------------------------------------------------------------------
async function loadTypes() {
  const types = await api("/api/types");
  state.types = types;
  state.typesByName = new Map(types.map((t) => [t.name, t]));
  $("#typeCount").textContent = types.length;

  const list = $("#typeList");
  list.innerHTML = types
    .map((t) => {
      const [domain, short] = t.name.includes(".") ? t.name.split(/\.(.+)/) : ["", t.name];
      return `<div class="type-row" data-name="${t.name}">
        <span class="name"><span class="domain">${domain}.</span>${short}</span>
        <span class="version">v${t.version}</span>
      </div>`;
    })
    .join("");

  list.addEventListener("click", (e) => {
    const row = e.target.closest(".type-row");
    if (row) openTypeModal(row.dataset.name);
  });

  const typePicker = $("#typePicker");
  typePicker.innerHTML = BROWSABLE_TYPES.map((name) => `<option value="${name}">${name}</option>`).join("");
  typePicker.addEventListener("change", () => loadObjectOptions(typePicker.value));
  await loadObjectOptions(typePicker.value);
}

async function loadObjectOptions(typeName) {
  const objectPicker = $("#objectPicker");
  objectPicker.innerHTML = `<option>Loading…</option>`;
  try {
    const result = await api(withIdentity(`/api/objects/${typeName}`));
    if (!result.items.length) {
      objectPicker.innerHTML = `<option value="">No objects yet</option>`;
      return;
    }
    objectPicker.innerHTML = result.items
      .map((item) => `<option value="${item.objectId}">${item.objectId} — ${escapeHtml(friendlyLabel(item.values))}</option>`)
      .join("");
  } catch (err) {
    objectPicker.innerHTML = `<option value="">${escapeHtml(err.message)}</option>`;
  }
}

function openTypeModal(name) {
  const t = state.typesByName.get(name);
  if (!t) return;

  const relRows = t.relationships.length
    ? t.relationships
        .map(
          (r) => `<tr>
        <td><code>${r.name}</code></td>
        <td>${r.targetType}</td>
        <td>${r.cardinality}</td>
        <td>${r.inverseName ? `<code>${r.inverseName}</code>` : "<span class=\"muted\">—</span>"}</td>
      </tr>`
        )
        .join("")
    : `<tr><td colspan="4" class="muted">None declared.</td></tr>`;

  const propertyPolicyChips = Object.entries(t.propertyPolicies || {})
    .map(([prop, policy]) => `<span class="chip">${prop} → ${policy}</span>`)
    .join("") || `<span class="muted">None — only the object-level policy applies.</span>`;

  $("#typeModal").innerHTML = `
    <button class="modal-close" id="modalCloseBtn">✕</button>
    <h1>${t.name}</h1>
    <p class="modal-sub">v${t.version}${t.extends ? ` · extends <code>${t.extends}</code>` : ""}${
      t.traits && t.traits.length ? ` · traits: ${t.traits.map((x) => `<code>${x}</code>`).join(", ")}` : ""
    }</p>
    <p>${t.description || "<span class=\"muted\">No description.</span>"}</p>

    <h3>Relationships</h3>
    <table class="rel-def-table">
      <thead><tr><th>Name</th><th>Target</th><th>Cardinality</th><th>Inverse</th></tr></thead>
      <tbody>${relRows}</tbody>
    </table>

    <h3>Actions</h3>
    <div class="chip-row">${t.actionNames.length ? t.actionNames.map((a) => `<span class="chip">${a}</span>`).join("") : '<span class="muted">None.</span>'}</div>

    <h3>Computed Properties</h3>
    <div class="chip-row">${t.computedPropertyNames.length ? t.computedPropertyNames.map((c) => `<span class="chip">${c}</span>`).join("") : '<span class="muted">None.</span>'}</div>

    <h3>Property-level Policies</h3>
    <div class="chip-row">${propertyPolicyChips}</div>

    <details>
      <summary>Raw JSON Schema (2020-12 + x-* vocabulary)</summary>
      <pre class="json-view">${prettyJson(t.schema)}</pre>
    </details>
  `;
  $("#typeModalOverlay").classList.remove("hidden");
  $("#modalCloseBtn").addEventListener("click", closeTypeModal);
}

function closeTypeModal() {
  $("#typeModalOverlay").classList.add("hidden");
}

// ---------------------------------------------------------------------------
// Object explorer
// ---------------------------------------------------------------------------
function openRoot(typeName, objectId) {
  if (!objectId) return;
  state.breadcrumb = [{ typeName, objectId }];
  state.openRelationships = new Set();
  renderCurrentObject();
}

function drillInto(typeName, objectId) {
  state.breadcrumb.push({ typeName, objectId });
  state.openRelationships = new Set();
  renderCurrentObject();
}

function jumpTo(index) {
  state.breadcrumb = state.breadcrumb.slice(0, index + 1);
  state.openRelationships = new Set();
  renderCurrentObject();
}

function renderBreadcrumbs() {
  const el = $("#breadcrumbs");
  if (!state.breadcrumb.length) { el.innerHTML = ""; return; }
  el.innerHTML = state.breadcrumb
    .map((crumb, i) => {
      const isLast = i === state.breadcrumb.length - 1;
      const label = `${crumb.typeName.split(".").pop()} <code>${crumb.objectId}</code>`;
      return `${i > 0 ? '<span class="sep">›</span>' : ""}<span class="crumb${isLast ? " current" : ""}" data-index="${i}">${label}</span>`;
    })
    .join("");
  el.onclick = (e) => {
    const crumb = e.target.closest(".crumb:not(.current)");
    if (crumb) jumpTo(Number(crumb.dataset.index));
  };
}

async function renderCurrentObject() {
  renderBreadcrumbs();
  const top = state.breadcrumb[state.breadcrumb.length - 1];
  if (!top) return;
  const container = $("#objectDetail");
  container.innerHTML = `<div class="empty-state small">Loading…</div>`;

  try {
    const [object, typeDef] = await Promise.all([
      api(withIdentity(`/api/objects/${top.typeName}/${top.objectId}`)),
      state.typesByName.has(top.typeName) ? Promise.resolve(state.typesByName.get(top.typeName)) : api(`/api/types/${top.typeName}`)
    ]);
    renderObjectCard(container, top.typeName, object, typeDef);
    renderActionsPanel(top.typeName);
  } catch (err) {
    renderObjectError(container, err);
    renderActionsPanel(null);
  }
}

function renderObjectError(container, err) {
  const isAuth = err.status === 403;
  container.innerHTML = `<div class="empty-state">
    <div class="empty-icon">${isAuth ? "⛔" : "!"}</div>
    <p><strong>${isAuth ? "Access denied" : "Error"}</strong><br/>${escapeHtml(err.message)}</p>
    ${isAuth ? `<p class="muted">The <strong>${state.identity}</strong> identity was denied by the policy engine — this is the runtime's object-level authorization boundary, not a bug.</p>` : ""}
  </div>`;
}

function provTooltip(entry) {
  if (!entry) return "No provenance recorded for this property.";
  const bits = [
    `system: ${entry.source.system}`,
    entry.source.recordId ? `record: ${entry.source.recordId}` : null,
    entry.confidence != null ? `confidence: ${entry.confidence}` : null,
    entry.classification ? `classification: ${entry.classification}` : null,
    `retrieved: ${relativeTime(entry.retrievedAt)}`
  ].filter(Boolean);
  return bits.join(" · ");
}

function renderObjectCard(container, typeName, object, typeDef) {
  const provByPath = new Map((object.provenance || []).map((p) => [p.propertyPath, p]));
  const values = object.values;

  const rows = Object.entries(values)
    .filter(([key]) => key !== "readinessStatus" && key !== "needsAttention") // shown as header badges instead, not duplicated as rows
    .map(([key, value]) => {
      const prov = provByPath.get(key);
      const provDot = state.showProvenance !== false
        ? `<span class="prov-dot" title="${escapeHtml(provTooltip(prov))}">i</span>`
        : "";
      const display = typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);
      return `<tr><td class="k">${key}${provDot}</td><td class="v">${escapeHtml(display)}</td></tr>`;
    })
    .join("");

  const restrictedKeys = Object.keys(typeDef.propertyPolicies || {}).filter((k) => !(k in values));
  const restrictedRows = restrictedKeys
    .map(
      (key) => `<tr class="restricted"><td class="k">🔒 ${key}</td><td class="v">restricted by policy "${typeDef.propertyPolicies[key]}" for identity "${state.identity}"</td></tr>`
    )
    .join("");

  const readiness = values.readinessStatus
    ? `<span class="badge ${READINESS_BADGE[values.readinessStatus] || "badge-warn"} badge-readiness">${values.readinessStatus}</span>`
    : "";
  // needsAttention combines this Aircraft's own maintenanceStatus with a live
  // check against a completely different adapter (open work orders) — see
  // ADR-0022 / docs/how-to/combine-multiple-sources.md. Only shown when true,
  // so a healthy Aircraft's card stays uncluttered.
  const needsAttention = values.needsAttention
    ? `<span class="badge badge-deny badge-readiness" title="Own maintenanceStatus is down/degraded, or an open work order exists against this aircraft (checked live against the maintenance system)">⚠ Needs attention</span>`
    : "";

  const relChips = typeDef.relationships
    .map((r) => {
      const isOpen = state.openRelationships.has(r.name);
      return `<button class="rel-chip${isOpen ? " open" : ""}" data-rel="${r.name}" data-target="${r.targetType}">
        ${r.name} <span class="cardinality">(${r.cardinality === "one-to-one" ? "1:1" : r.cardinality === "one-to-many" ? "1:N" : "N:N"})</span>
      </button>`;
    })
    .join("");

  container.innerHTML = `
    <div class="obj-card">
      <div class="obj-card-head">
        <span class="type-name">${typeName}</span>
        <span class="obj-id">${object.objectId}</span>
        ${readiness}
        ${needsAttention}
      </div>
      <table class="prop-table">${rows}${restrictedRows}</table>
      ${typeDef.relationships.length ? `<div class="rel-chips">${relChips}</div><div id="relExpansion"></div>` : ""}
    </div>
  `;

  $$(".rel-chip", container).forEach((chip) => {
    chip.addEventListener("click", () => toggleRelationship(chip, typeName, object.objectId, chip.dataset.rel));
  });

  // Re-render any relationships that were already expanded before navigating here.
  state.openRelationships.forEach((relName) => {
    const chip = $(`.rel-chip[data-rel="${relName}"]`, container);
    if (chip) loadRelationship(typeName, object.objectId, relName);
  });
}

async function toggleRelationship(chip, typeName, objectId, relName) {
  if (state.openRelationships.has(relName)) {
    state.openRelationships.delete(relName);
    chip.classList.remove("open");
    const existing = $(`.rel-expansion[data-rel="${relName}"]`);
    if (existing) existing.remove();
    return;
  }
  state.openRelationships.add(relName);
  chip.classList.add("open");
  await loadRelationship(typeName, objectId, relName);
}

async function loadRelationship(typeName, objectId, relName) {
  const host = $("#relExpansion");
  if (!host) return;
  let box = $(`.rel-expansion[data-rel="${relName}"]`, host);
  const label = `<div class="rel-expansion-label">${relName}</div>`;
  if (!box) {
    box = document.createElement("div");
    box.className = "rel-expansion";
    box.dataset.rel = relName;
    box.innerHTML = `${label}<div class="rel-row">Loading…</div>`;
    host.appendChild(box);
  }
  try {
    const related = await api(withIdentity(`/api/objects/${typeName}/${objectId}/relationships/${relName}`));
    if (!related.length) {
      box.innerHTML = `${label}<div class="rel-row"><span class="rsummary">No related objects (or none visible to <strong>${state.identity}</strong>).</span></div>`;
      return;
    }
    box.innerHTML =
      label +
      related
        .map(
          (r) => `<div class="rel-row">
          <span class="rid">${r.objectId}</span>
          <span class="rsummary">${escapeHtml(friendlyLabel(r.values))}</span>
          <button class="btn btn-sm btn-ghost" data-drill-type="${r.typeName}" data-drill-id="${r.objectId}">View →</button>
        </div>`
        )
        .join("");
    $$("[data-drill-type]", box).forEach((btn) => {
      btn.addEventListener("click", () => drillInto(btn.dataset.drillType, btn.dataset.drillId));
    });
  } catch (err) {
    box.innerHTML = `${label}<div class="rel-row"><span class="rsummary">${escapeHtml(err.message)}</span></div>`;
  }
}

// ---------------------------------------------------------------------------
// Actions panel
// ---------------------------------------------------------------------------
async function renderActionsPanel(typeName) {
  const host = $("#actionsList");
  if (!typeName) {
    host.innerHTML = `<div class="empty-state small">Open an object to see its available Actions.</div>`;
    $("#actionCount").textContent = "0";
    return;
  }
  host.innerHTML = `<div class="empty-state small">Loading…</div>`;
  const actions = await api(withIdentity(`/api/actions/${typeName}`));
  $("#actionCount").textContent = actions.length;

  if (!actions.length) {
    host.innerHTML = `<div class="empty-state small">No Actions apply to <code>${typeName}</code>.</div>`;
    return;
  }

  const currentObjectId = state.breadcrumb[state.breadcrumb.length - 1]?.objectId ?? "";

  host.innerHTML = actions
    .map((a, i) => {
      const props = Object.entries(a.inputSchema.properties || {});
      const requiredSet = new Set(a.inputSchema.required || []);
      const fields = props
        .map(([prop]) => {
          const prefill = prop === "maintenanceEventId" && typeName === "airforce.MaintenanceEvent" ? currentObjectId : "";
          return `<label>${prop}${requiredSet.has(prop) ? " *" : ""}
            <input type="text" data-field="${prop}" value="${escapeHtml(prefill)}" placeholder="Enter a value" />
          </label>`;
        })
        .join("");

      return `<div class="action-card" data-action-index="${i}">
        <div class="action-card-head">
          <span class="name">${a.name}</span>
          <span class="badge ${a.authorized ? "badge-ok" : "badge-deny"}">${a.authorized ? "Authorized" : "Not authorized"}</span>
        </div>
        <p class="action-desc">${a.description}</p>
        ${
          a.authorized
            ? `<div class="action-form">${fields}<button class="btn btn-primary btn-sm" data-invoke="${a.name}">Invoke</button></div>`
            : `<p class="action-desc muted">The <strong>${state.identity}</strong> identity's policy check fails before this action would even run its preconditions.</p>`
        }
        <div class="action-result" hidden></div>
      </div>`;
    })
    .join("");

  $$("[data-invoke]", host).forEach((btn) => {
    btn.addEventListener("click", () => invokeAction(btn));
  });
}

async function invokeAction(btn) {
  const card = btn.closest(".action-card");
  const name = btn.dataset.invoke;
  const input = {};
  $$("input[data-field]", card).forEach((inp) => { input[inp.dataset.field] = inp.value; });

  const resultEl = $(".action-result", card);
  resultEl.hidden = false;
  resultEl.className = "action-result";
  resultEl.textContent = "Invoking…";
  btn.disabled = true;

  try {
    const outcome = await api(withIdentity(`/api/actions/${name}/invoke`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input)
    });
    if (outcome.ok) {
      resultEl.classList.add("ok");
      resultEl.textContent = `Success:\n${JSON.stringify(outcome.result, null, 2)}`;
      const top = state.breadcrumb[state.breadcrumb.length - 1];
      if (top && state.openRelationships.size) {
        state.openRelationships.forEach((rel) => loadRelationship(top.typeName, top.objectId, rel));
      }
    } else {
      resultEl.classList.add("err");
      resultEl.textContent = `${outcome.error}: ${outcome.message}`;
    }
  } catch (err) {
    resultEl.classList.add("err");
    resultEl.textContent = err.message;
  } finally {
    btn.disabled = false;
    refreshAudit();
  }
}

// ---------------------------------------------------------------------------
// Query tab
// ---------------------------------------------------------------------------
const QUERY_EXAMPLES = {
  "All aircraft": { type: "airforce.Aircraft" },
  "Aircraft + relationships": {
    type: "airforce.Aircraft",
    include: [{ relationship: "components" }, { relationship: "maintenance" }],
    includeProvenance: true
  },
  "Filter by tail number": {
    type: "airforce.Aircraft",
    filter: { property: "tailNumber", operator: "eq", value: "AF86-0147" }
  }
};

function initQueryTab() {
  const input = $("#queryInput");
  input.value = JSON.stringify(QUERY_EXAMPLES["All aircraft"], null, 2);
  $("#queryIdentityNote").textContent = state.identity;

  $("#queryExamples").innerHTML = Object.keys(QUERY_EXAMPLES)
    .map((label) => `<button class="btn btn-sm btn-ghost" data-example="${label}">${label}</button>`)
    .join("");
  $("#queryExamples").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-example]");
    if (btn) input.value = JSON.stringify(QUERY_EXAMPLES[btn.dataset.example], null, 2);
  });

  $("#runQueryBtn").addEventListener("click", async () => {
    const out = $("#queryOutput");
    let query;
    try {
      query = JSON.parse(input.value);
    } catch {
      out.innerHTML = `<span class="muted">Invalid JSON — fix the query and try again.</span>`;
      return;
    }
    out.innerHTML = `<span class="muted">Running…</span>`;
    try {
      const result = await api(withIdentity("/api/query"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(query)
      });
      out.innerHTML = prettyJson(result);
    } catch (err) {
      out.innerHTML = `<span class="muted">${escapeHtml(err.message)}</span>`;
    } finally {
      refreshAudit();
    }
  });
}

// ---------------------------------------------------------------------------
// MCP Console tab
// ---------------------------------------------------------------------------
function mcpOps() {
  const token = () => IDENTITY_TOKEN[state.identity];
  return [
    { title: "resources/list", sub: "Discover every browsable resource", run: () => api("/api/mcp/resources") },
    { title: "resources/read — Aircraft type", sub: "typesys://types/airforce.Aircraft", run: () => api("/api/mcp/resource", post({ uri: "typesys://types/airforce.Aircraft" })) },
    {
      title: "resources/read — Aircraft object",
      sub: `typesys://objects/airforce.Aircraft/AF86-0147?token=${token() || "(none)"}`,
      run: () => api("/api/mcp/resource", post({ uri: `typesys://objects/airforce.Aircraft/AF86-0147${token() ? `?token=${token()}` : ""}` }))
    },
    {
      title: "resources/read — provenance",
      sub: "…/AF86-0147/provenance/maintenanceStatus",
      run: () =>
        api(
          "/api/mcp/resource",
          post({ uri: `typesys://objects/airforce.Aircraft/AF86-0147/provenance/maintenanceStatus${token() ? `?token=${token()}` : ""}` })
        )
    },
    { title: "tools/list", sub: "Discover governed Actions + the query tool", run: () => api("/api/mcp/tools") },
    {
      title: "tools/call — query",
      sub: `type=airforce.Aircraft, as ${state.identity}`,
      run: () => api("/api/mcp/tool", post({ name: "query", arguments: { type: "airforce.Aircraft", authToken: token() } }))
    },
    {
      title: "tools/call — CreateMaintenanceWorkOrder",
      sub: `as ${state.identity} — watch this flip with the identity switch`,
      run: () =>
        api(
          "/api/mcp/tool",
          post({ name: "CreateMaintenanceWorkOrder", arguments: { maintenanceEventId: "EVT-9001", assignedTo: "MCP Console Demo", authToken: token() } })
        )
    }
  ];
}

function post(body) {
  return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

function initMcpTab() {
  const list = $("#mcpOpList");
  function render() {
    list.innerHTML = mcpOps()
      .map((op, i) => `<button class="mcp-op" data-op="${i}"><span class="title">${op.title}</span><span class="sub">${escapeHtml(op.sub)}</span></button>`)
      .join("");
    $$(".mcp-op", list).forEach((btn) => {
      btn.addEventListener("click", async () => {
        const out = $("#mcpOutput");
        out.innerHTML = `<span class="muted">Calling…</span>`;
        try {
          const result = await mcpOps()[Number(btn.dataset.op)].run();
          out.innerHTML = prettyJson(result);
        } catch (err) {
          out.innerHTML = `<span class="muted">${escapeHtml(err.message)}</span>`;
        } finally {
          refreshAudit();
        }
      });
    });
  }
  render();
  document.addEventListener("identity-changed", render);
}

// ---------------------------------------------------------------------------
// Audit drawer
// ---------------------------------------------------------------------------
function initAuditDrawer() {
  const drawer = $("#auditDrawer");
  const body = $("#auditBody");
  $("#auditToggle").addEventListener("click", () => {
    const nowOpen = body.hidden;
    body.hidden = !nowOpen;
    drawer.classList.toggle("open", nowOpen);
  });
  refreshAudit();
  setInterval(refreshAudit, 4000);
}

async function refreshAudit() {
  try {
    const events = await api("/api/audit");
    $("#auditCount").textContent = events.length;
    $("#auditRows").innerHTML = events
      .slice(0, 60)
      .map(
        (e) => `<tr>
          <td class="time">${new Date(e.timestamp).toLocaleTimeString()}</td>
          <td class="subject">${e.subjectId}</td>
          <td>${e.action}</td>
          <td class="resource">${e.resource.typeName}${e.resource.objectId ? `/${e.resource.objectId}` : ""}${e.resource.propertyPath ? `.${e.resource.propertyPath}` : ""}</td>
          <td><span class="decision-pill ${e.decision}">${e.decision}</span></td>
          <td class="reason">${e.reason ? escapeHtml(e.reason) : e.outcome === "success" ? "action executed" : ""}</td>
        </tr>`
      )
      .join("");
  } catch {
    // Non-fatal — the drawer just stays stale until the next tick.
  }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
async function init() {
  initTabs();
  initIdentitySwitch();
  initQueryTab();
  initMcpTab();
  initAuditDrawer();

  $("#typeModalOverlay").addEventListener("click", (e) => {
    if (e.target.id === "typeModalOverlay") closeTypeModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeTypeModal();
  });

  $("#provToggle").addEventListener("change", (e) => {
    state.showProvenance = e.target.checked;
    if (state.breadcrumb.length) renderCurrentObject();
  });
  state.showProvenance = true;

  $("#loadObjectBtn").addEventListener("click", () => {
    const typeName = $("#typePicker").value;
    const objectId = $("#objectPicker").value;
    openRoot(typeName, objectId);
  });

  await loadTypes();
}

init();
