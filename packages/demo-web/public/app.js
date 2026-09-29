// TypeS demo — vanilla JS, no build step, no framework. Talks to the
// Express API in server.ts, which drives one real SemanticRuntime hosting
// two domains (and, via the MCP Console tab, the real MCP server on that
// same runtime).

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  identity: "maintainer",
  identities: [], // [{key, domain, token, subjectId, roles}]
  runtime: null, // {queryLimits, maxConcurrency, rateLimit, dataSources}
  types: [],
  typesByName: new Map(),
  breadcrumb: [], // [{typeName, objectId}]
  openRelationships: new Set(),
  showSources: true,
  query: { view: "cards", last: null, lastResult: null, lastError: null },
  audit: { decision: "all", subject: "", seen: new Set(), events: [] }
};

const IDENTITY_LABEL = { maintainer: "Maintainer", viewer: "Viewer", clinician: "Clinician", patient: "Patient", anonymous: "Anonymous" };
const DOMAIN_LABEL = { airforce: "Air Force", hospital: "Hospital", none: "" };

const IDENTITY_HINTS = {
  maintainer:
    "Acting as <strong>Maintainer</strong> (Air Force): full read access to aircraft, and allowed to invoke <code>CreateMaintenanceWorkOrder</code>. Hospital data is off-limits: each domain's policies are its own.",
  viewer:
    "Acting as <strong>Viewer</strong> (Air Force): can read aircraft, but <code>maintenanceStatus</code> is redacted, filtering on it is refused, and actions are denied.",
  clinician:
    "Acting as <strong>Clinician</strong> (Hospital): reads patients, providers, and appointments, including the staff-only <code>medicalRecordNumber</code>. Aircraft are off-limits.",
  patient:
    "Acting as <strong>Patient</strong> (Hospital): can read patient records, but <code>medicalRecordNumber</code> is staff-only and redacted.",
  anonymous: "Acting as <strong>Anonymous</strong>: no roles at all. Every object read is denied at the object level, except the public provider directory."
};

const READINESS_BADGE = { FMC: "badge-ok", PMC: "badge-warn", NMC: "badge-deny", UNKNOWN: "badge-warn" };

// ---------------------------------------------------------------------------
// Tiny helpers
// ---------------------------------------------------------------------------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function prettyJson(value) {
  const json = JSON.stringify(value, null, 2);
  if (json === undefined) return '<span class="muted">undefined</span>';
  let html = escapeHtml(json);
  html = html.replace(/(&quot;(?:[^"\\]|\\.)*?&quot;)(:?)/g, (_m, str, colon) => `<span class="${colon ? "jk" : "js"}">${str}</span>${colon}`);
  html = html.replace(/: (-?\d+(?:\.\d+)?)/g, ': <span class="jn">$1</span>');
  html = html.replace(/: (true|false|null)/g, ': <span class="jb">$1</span>');
  return html;
}

function relativeTime(iso) {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
}

function friendlyLabel(values) {
  return values.name || values.tailNumber || values.description || values.eventType || values.status || values.specialty || values.id || "(unnamed)";
}

function post(body) {
  return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

function withIdentity(path, identity = state.identity) {
  return `${path}${path.includes("?") ? "&" : "?"}identity=${encodeURIComponent(identity)}`;
}

function tokenFor(key) {
  return state.identities.find((i) => i.key === key)?.token ?? "";
}

/** Low-level request: never throws on HTTP errors, always reports the runtime stats header. */
async function request(path, opts, label) {
  const res = await fetch(path, opts);
  const body = await res.json().catch(() => null);
  const header = res.headers.get("X-TypeS-Stats");
  const stats = header ? JSON.parse(header) : null;
  if (stats && label !== false) renderStats(label ?? `${opts?.method ?? "GET"} ${path.split("?")[0]}`, stats, res.status);
  return { status: res.status, ok: res.ok, body, stats };
}

/** Throws on HTTP errors, with `status` and the server's `{error, message}` attached. */
async function api(path, opts, label) {
  const { status, ok, body } = await request(path, opts, label);
  if (!ok) {
    const err = new Error((body && body.message) || `HTTP ${status}`);
    err.status = status;
    err.body = body;
    throw err;
  }
  return body;
}

// ---------------------------------------------------------------------------
// Stats bar: what the last runtime call actually did
// ---------------------------------------------------------------------------
function renderStats(label, stats, status) {
  const entries = Object.entries(stats.calls);
  const total = entries.reduce((n, [, c]) => n + c, 0);
  const max = state.runtime?.maxConcurrency;
  const systems = entries.map(([ds, c]) => `<span class="stat-chip">${escapeHtml(ds)} <strong>${c}</strong></span>`).join("");
  $("#statsBody").classList.remove("muted");
  $("#statsBody").innerHTML = `
    <span class="stat-req mono">${escapeHtml(label)}</span>
    <span class="status-pill s${String(status)[0]}">${status}</span>
    <span>${total} adapter call${total === 1 ? "" : "s"}</span>
    ${systems}
    ${total ? `<span>peak <strong>${stats.peakInFlight}</strong>${max ? ` / ${max}` : ""} in flight</span>` : ""}
    <span class="muted">${stats.durationMs} ms</span>`;
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
function initTabs() {
  $$(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      $$(".tab").forEach((b) => {
        b.classList.toggle("active", b === btn);
        b.setAttribute("aria-selected", String(b === btn));
      });
      $$(".tab-panel").forEach((p) => p.classList.toggle("active", p.id === `tab-${btn.dataset.tab}`));
    });
  });
}

// ---------------------------------------------------------------------------
// Identity switch
// ---------------------------------------------------------------------------
function initIdentitySwitch() {
  const container = $("#identitySwitch");
  let lastDomain = null;
  container.innerHTML = state.identities
    .map((i) => {
      const group = i.domain !== lastDomain && DOMAIN_LABEL[i.domain] ? `<span class="identity-group">${DOMAIN_LABEL[i.domain]}</span>` : "";
      lastDomain = i.domain;
      return `${group}<button class="identity-btn${i.key === state.identity ? " active" : ""}" data-key="${i.key}" title="${escapeHtml(
        `${i.subjectId} · roles: ${i.roles.join(", ") || "none"}`
      )}"><span class="identity-dot"></span>${IDENTITY_LABEL[i.key] ?? i.key}</button>`;
    })
    .join("");

  container.addEventListener("click", (e) => {
    const btn = e.target.closest(".identity-btn");
    if (!btn) return;
    state.identity = btn.dataset.key;
    $$(".identity-btn", container).forEach((b) => b.classList.toggle("active", b.dataset.key === state.identity));
    $("#hintBanner").innerHTML = IDENTITY_HINTS[state.identity] ?? "";
    $("#queryIdentityNote").textContent = IDENTITY_LABEL[state.identity];
    document.dispatchEvent(new Event("identity-changed"));
    // Re-evaluate whatever is on screen under the new identity.
    loadObjectOptions($("#typePicker").value);
    if (state.breadcrumb.length) renderCurrentObject();
    else renderActionsPanel(null);
  });

  $("#hintBanner").innerHTML = IDENTITY_HINTS[state.identity];
}

// ---------------------------------------------------------------------------
// Types panel + modal
// ---------------------------------------------------------------------------
const DOMAIN_BLURB = {
  core: "Shared base types every domain builds on.",
  airforce: "Aircraft from a repository, maintenance from an external REST system.",
  hospital: "An unrelated domain, added with zero changes to core."
};

function domainOf(typeName) {
  return typeName.split(".")[0];
}

async function loadTypes() {
  const types = await api("/api/types", undefined, false);
  state.types = types;
  state.typesByName = new Map(types.map((t) => [t.name, t]));
  $("#typeCount").textContent = types.length;

  const domains = [...new Set(types.map((t) => domainOf(t.name)))];
  $("#typeList").innerHTML = domains
    .map(
      (d) => `<div class="type-group">
        <div class="type-group-head"><span>${escapeHtml(d)}</span><span class="muted">${DOMAIN_BLURB[d] ?? ""}</span></div>
        ${types
          .filter((t) => domainOf(t.name) === d)
          .map(
            (t) => `<div class="type-row" data-name="${escapeHtml(t.name)}" tabindex="0" role="button">
              <span class="name">${escapeHtml(t.name.split(".").slice(1).join("."))}</span>
              ${t.computedPropertyNames.length ? '<span class="mini-tag">computed</span>' : ""}
              ${Object.keys(t.propertyPolicies).length ? '<span class="mini-tag lock">🔒</span>' : ""}
              <span class="version">v${escapeHtml(t.version)}</span>
            </div>`
          )
          .join("")}
      </div>`
    )
    .join("");

  $("#typeList").addEventListener("click", (e) => {
    const row = e.target.closest(".type-row");
    if (row) openTypeModal(row.dataset.name);
  });
  $("#typeList").addEventListener("keydown", (e) => {
    const row = e.target.closest(".type-row");
    if (row && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      openTypeModal(row.dataset.name);
    }
  });

  const browsable = types.filter((t) => domainOf(t.name) !== "core");
  const picker = $("#typePicker");
  picker.innerHTML = [...new Set(browsable.map((t) => domainOf(t.name)))]
    .map(
      (d) =>
        `<optgroup label="${escapeHtml(DOMAIN_LABEL[d] || d)}">${browsable
          .filter((t) => domainOf(t.name) === d)
          .map((t) => `<option value="${escapeHtml(t.name)}">${escapeHtml(t.name)}</option>`)
          .join("")}</optgroup>`
    )
    .join("");
  picker.value = "airforce.Aircraft";
  picker.addEventListener("change", () => loadObjectOptions(picker.value));
  await loadObjectOptions(picker.value);
}

async function loadObjectOptions(typeName) {
  const objectPicker = $("#objectPicker");
  objectPicker.innerHTML = "<option>Loading…</option>";
  try {
    const result = await api(withIdentity(`/api/objects/${typeName}`), undefined, false);
    objectPicker.innerHTML = result.items.length
      ? result.items.map((item) => `<option value="${escapeHtml(item.objectId)}">${escapeHtml(item.objectId)} — ${escapeHtml(friendlyLabel(item.values))}</option>`).join("")
      : '<option value="">No objects</option>';
  } catch (err) {
    objectPicker.innerHTML = `<option value="">${err.status === 403 ? `Not visible to ${IDENTITY_LABEL[state.identity]}` : escapeHtml(err.message)}</option>`;
  }
}

function openTypeModal(name) {
  const t = state.typesByName.get(name);
  if (!t) return;
  const relRows = t.relationships.length
    ? t.relationships
        .map(
          (r) => `<tr><td><code>${escapeHtml(r.name)}</code></td><td>${escapeHtml(r.targetType)}</td><td>${escapeHtml(r.cardinality)}</td><td class="mono small">${escapeHtml(r.dataSourceId)}</td></tr>`
        )
        .join("")
    : '<tr><td colspan="4" class="muted">None declared.</td></tr>';
  const computed = t.computedProperties.length
    ? t.computedProperties
        .map((c) => `<span class="chip">${escapeHtml(c.name)} <span class="muted">← ${c.dependsOn.map(escapeHtml).join(", ") || "no dependencies"}</span></span>`)
        .join("")
    : '<span class="muted">None.</span>';
  const propertyPolicyChips =
    Object.entries(t.propertyPolicies)
      .map(([prop, policy]) => `<span class="chip">🔒 ${escapeHtml(prop)} → ${escapeHtml(policy)}</span>`)
      .join("") || '<span class="muted">None: only the object-level policy applies.</span>';

  $("#typeModal").innerHTML = `
    <button class="modal-close" id="modalCloseBtn" aria-label="Close">✕</button>
    <h1>${escapeHtml(t.name)}</h1>
    <p class="modal-sub">v${escapeHtml(t.version)}${t.extends ? ` · extends <code>${escapeHtml(t.extends)}</code>` : ""}${
      t.traits && t.traits.length ? ` · traits: ${t.traits.map((x) => `<code>${escapeHtml(x)}</code>`).join(", ")}` : ""
    }</p>
    <p>${t.description ? escapeHtml(t.description) : '<span class="muted">No description.</span>'}</p>
    <h3>Object policy</h3>
    <div class="chip-row"><span class="chip">${escapeHtml(t.objectPolicy)}</span></div>
    <h3>Relationships</h3>
    <table class="rel-def-table">
      <thead><tr><th>Name</th><th>Target</th><th>Cardinality</th><th>Resolved by</th></tr></thead>
      <tbody>${relRows}</tbody>
    </table>
    <h3>Actions</h3>
    <div class="chip-row">${t.actionNames.length ? t.actionNames.map((a) => `<span class="chip">${escapeHtml(a)}</span>`).join("") : '<span class="muted">None.</span>'}</div>
    <h3>Computed properties</h3>
    <div class="chip-row">${computed}</div>
    <h3>Property-level policies</h3>
    <div class="chip-row">${propertyPolicyChips}</div>
    <details>
      <summary>Raw JSON Schema (2020-12 + x-* vocabulary)</summary>
      <pre class="json-view">${prettyJson(t.schema)}</pre>
    </details>`;
  $("#typeModalOverlay").classList.remove("hidden");
  $("#modalCloseBtn").addEventListener("click", closeTypeModal);
  $("#modalCloseBtn").focus();
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
  el.innerHTML = state.breadcrumb
    .map((crumb, i) => {
      const isLast = i === state.breadcrumb.length - 1;
      return `${i > 0 ? '<span class="sep">›</span>' : ""}<span class="crumb${isLast ? " current" : ""}" data-index="${i}">${escapeHtml(
        crumb.typeName.split(".").pop()
      )} <code>${escapeHtml(crumb.objectId)}</code></span>`;
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
  container.innerHTML = '<div class="empty-state small">Loading…</div>';
  try {
    const typeDef = state.typesByName.get(top.typeName) ?? (await api(`/api/types/${top.typeName}`, undefined, false));
    const object = await api(withIdentity(`/api/objects/${top.typeName}/${top.objectId}`));
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
    ${
      isAuth
        ? `<p class="muted">The policy engine denied <strong>${IDENTITY_LABEL[state.identity]}</strong> at the object level. The denial is in the audit log below.</p>`
        : ""
    }
  </div>`;
}

function renderObjectCard(container, typeName, object, typeDef) {
  const provByPath = new Map((object.provenance || []).map((p) => [p.propertyPath, p]));
  const computedNames = new Set(typeDef.computedPropertyNames);
  const values = object.values;

  const sourceTag = (key) => {
    if (!state.showSources) return "";
    const prov = provByPath.get(key);
    return prov
      ? `<button class="source-tag" data-prov="${escapeHtml(key)}" title="Where this value came from">${escapeHtml(prov.source.system)}</button>`
      : "";
  };

  const storedRows = Object.entries(values)
    .filter(([key]) => !computedNames.has(key))
    .map(([key, value]) => {
      const display = typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);
      return `<tr><td class="k">${escapeHtml(key)}</td><td class="v">${escapeHtml(display)}</td><td class="s">${sourceTag(key)}</td></tr>`;
    })
    .join("");

  const computedRows = typeDef.computedProperties
    .filter((c) => c.name in values)
    .map(
      (c) => `<tr class="computed"><td class="k">${escapeHtml(c.name)} <span class="mini-tag">computed</span></td>
        <td class="v">${escapeHtml(String(values[c.name]))}<div class="derives muted">from ${c.dependsOn.map((d) => `<code>${escapeHtml(d)}</code>`).join(", ")}</div></td>
        <td class="s">${state.showSources ? `<button class="source-tag" data-prov="${escapeHtml(c.name)}" title="Trace the sources it was derived from">trace</button>` : ""}</td></tr>`
    )
    .join("");

  const restrictedRows = Object.keys(typeDef.propertyPolicies)
    .filter((k) => !(k in values))
    .map(
      (key) =>
        `<tr class="restricted"><td class="k">🔒 ${escapeHtml(key)}</td><td class="v" colspan="2">redacted: policy <code>${escapeHtml(
          typeDef.propertyPolicies[key]
        )}</code> denies ${IDENTITY_LABEL[state.identity]}</td></tr>`
    )
    .join("");

  const readiness = values.readinessStatus
    ? `<span class="badge ${READINESS_BADGE[values.readinessStatus] || "badge-warn"}">${escapeHtml(values.readinessStatus)}</span>`
    : "";
  const needsAttention = values.needsAttention
    ? '<span class="badge badge-deny" title="Own maintenanceStatus is down or degraded, or an open work order exists (checked live against the maintenance system)">⚠ Needs attention</span>'
    : "";

  const relChips = typeDef.relationships
    .map((r) => {
      const isOpen = state.openRelationships.has(r.name);
      const card = r.cardinality === "one-to-one" ? "1:1" : r.cardinality === "one-to-many" ? "1:N" : "N:N";
      return `<button class="rel-chip${isOpen ? " open" : ""}" data-rel="${escapeHtml(r.name)}" aria-pressed="${isOpen}">${escapeHtml(r.name)} <span class="cardinality">(${card})</span></button>`;
    })
    .join("");

  container.innerHTML = `
    <div class="obj-card">
      <div class="obj-card-head">
        <span class="type-name">${escapeHtml(typeName)}</span>
        <span class="obj-id">${escapeHtml(object.objectId)}</span>
        <span class="head-badges">${readiness}${needsAttention}</span>
      </div>
      <table class="prop-table">${storedRows}${computedRows}${restrictedRows}</table>
      <div id="provPanel" class="prov-panel" hidden></div>
      ${typeDef.relationships.length ? `<div class="rel-chips">${relChips}</div><div id="relExpansion"></div>` : ""}
    </div>`;

  $$("[data-prov]", container).forEach((btn) => btn.addEventListener("click", () => showProvenance(typeName, object.objectId, btn.dataset.prov, computedNames.has(btn.dataset.prov))));
  $$(".rel-chip", container).forEach((chip) => chip.addEventListener("click", () => toggleRelationship(chip, typeName, object.objectId, chip.dataset.rel)));
  state.openRelationships.forEach((relName) => loadRelationship(typeName, object.objectId, relName));
}

async function showProvenance(typeName, objectId, property, isComputed) {
  const panel = $("#provPanel");
  panel.hidden = false;
  panel.innerHTML = '<div class="muted">Tracing…</div>';
  try {
    const entries = await api(withIdentity(`/api/objects/${typeName}/${objectId}/provenance/${property}`));
    const rows = entries
      .map(
        (p) => `<li>
          <div><code>${escapeHtml(p.propertyPath)}</code> ← <strong>${escapeHtml(p.source.system)}</strong> <span class="muted mono">${escapeHtml(p.source.dataSourceId)}</span></div>
          <div class="muted small">record ${escapeHtml(p.source.recordId ?? "—")}${p.source.field ? ` · field ${escapeHtml(p.source.field)}` : ""} · retrieved ${relativeTime(p.retrievedAt)}${
            p.confidence != null ? ` · confidence ${p.confidence}` : ""
          }${p.classification ? ` · ${escapeHtml(p.classification)}` : ""}</div>
        </li>`
      )
      .join("");
    panel.innerHTML = `
      <div class="prov-head"><strong>Provenance of <code>${escapeHtml(property)}</code></strong>
        <button class="btn btn-sm btn-ghost" id="provClose">Close</button></div>
      ${isComputed ? '<p class="muted small">Computed values aren\'t stored anywhere; this is the provenance of every value it was derived from.</p>' : ""}
      ${rows ? `<ul class="prov-list">${rows}</ul>` : '<p class="muted small">No provenance recorded.</p>'}`;
  } catch (err) {
    panel.innerHTML = `<div class="prov-head"><strong>Provenance of <code>${escapeHtml(property)}</code></strong><button class="btn btn-sm btn-ghost" id="provClose">Close</button></div><p class="err-text">${escapeHtml(
      err.message
    )}</p>`;
  }
  $("#provClose").addEventListener("click", () => {
    panel.hidden = true;
  });
}

async function toggleRelationship(chip, typeName, objectId, relName) {
  if (state.openRelationships.has(relName)) {
    state.openRelationships.delete(relName);
    chip.classList.remove("open");
    chip.setAttribute("aria-pressed", "false");
    $(`.rel-expansion[data-rel="${CSS.escape(relName)}"]`)?.remove();
    return;
  }
  state.openRelationships.add(relName);
  chip.classList.add("open");
  chip.setAttribute("aria-pressed", "true");
  await loadRelationship(typeName, objectId, relName);
}

async function loadRelationship(typeName, objectId, relName) {
  const host = $("#relExpansion");
  if (!host) return;
  let box = $(`.rel-expansion[data-rel="${CSS.escape(relName)}"]`, host);
  const label = `<div class="rel-expansion-label">${escapeHtml(relName)}</div>`;
  if (!box) {
    box = document.createElement("div");
    box.className = "rel-expansion";
    box.dataset.rel = relName;
    box.innerHTML = `${label}<div class="rel-row">Loading…</div>`;
    host.appendChild(box);
  }
  try {
    const related = await api(withIdentity(`/api/objects/${typeName}/${objectId}/relationships/${relName}`));
    box.innerHTML = related.length
      ? label +
        related
          .map(
            (r) => `<div class="rel-row">
              <span class="rid">${escapeHtml(r.objectId)}</span>
              <span class="rsummary">${escapeHtml(friendlyLabel(r.values))}</span>
              <button class="btn btn-sm btn-ghost" data-drill-type="${escapeHtml(r.typeName)}" data-drill-id="${escapeHtml(r.objectId)}">View →</button>
            </div>`
          )
          .join("")
      : `${label}<div class="rel-row"><span class="rsummary">No related objects visible to <strong>${IDENTITY_LABEL[state.identity]}</strong>.</span></div>`;
    $$("[data-drill-type]", box).forEach((btn) => btn.addEventListener("click", () => drillInto(btn.dataset.drillType, btn.dataset.drillId)));
  } catch (err) {
    box.innerHTML = `${label}<div class="rel-row"><span class="rsummary err-text">${escapeHtml(err.message)}</span></div>`;
  }
}

// ---------------------------------------------------------------------------
// Actions panel
// ---------------------------------------------------------------------------
async function renderActionsPanel(typeName) {
  const host = $("#actionsList");
  if (!typeName) {
    host.innerHTML = '<div class="empty-state small">Open an object to see its available Actions.</div>';
    $("#actionCount").textContent = "0";
    return;
  }
  host.innerHTML = '<div class="empty-state small">Loading…</div>';
  const actions = await api(withIdentity(`/api/actions/${typeName}`), undefined, false);
  $("#actionCount").textContent = actions.length;
  if (!actions.length) {
    host.innerHTML = `<div class="empty-state small"><p>No Actions apply to <code>${escapeHtml(typeName)}</code>. Open a MaintenanceEvent to try one.</p></div>`;
    return;
  }
  const currentObjectId = state.breadcrumb[state.breadcrumb.length - 1]?.objectId ?? "";

  host.innerHTML = actions
    .map((a) => {
      const required = new Set(a.inputSchema.required || []);
      const fields = Object.keys(a.inputSchema.properties || {})
        .map((prop) => {
          const prefill = prop === "maintenanceEventId" && typeName === "airforce.MaintenanceEvent" ? currentObjectId : "";
          return `<label>${escapeHtml(prop)}${required.has(prop) ? " *" : ""}
            <input type="text" data-field="${escapeHtml(prop)}" value="${escapeHtml(prefill)}" placeholder="${required.has(prop) ? "required" : "optional"}" />
          </label>`;
        })
        .join("");
      return `<div class="action-card">
        <div class="action-card-head">
          <span class="name">${escapeHtml(a.name)}</span>
          <span class="badge ${a.authorized ? "badge-ok" : "badge-deny"}">${a.authorized ? "Authorized" : "Not authorized"}</span>
        </div>
        <p class="action-desc">${escapeHtml(a.description)}</p>
        <div class="action-form">${fields}
          <button class="btn btn-primary btn-sm" data-invoke="${escapeHtml(a.name)}">Invoke</button>
          <p class="action-desc muted">Blank fields are left out, so a missing required field shows input validation.${
            a.authorized ? "" : ` As ${IDENTITY_LABEL[state.identity]}, the policy check refuses first, whatever you enter.`
          }</p>
        </div>
        <div class="action-result" hidden></div>
      </div>`;
    })
    .join("");

  $$("[data-invoke]", host).forEach((btn) => btn.addEventListener("click", () => invokeAction(btn)));
}

async function invokeAction(btn) {
  const card = btn.closest(".action-card");
  const input = {};
  $$("input[data-field]", card).forEach((inp) => {
    if (inp.value.trim()) input[inp.dataset.field] = inp.value.trim();
  });
  const resultEl = $(".action-result", card);
  resultEl.hidden = false;
  resultEl.className = "action-result";
  resultEl.textContent = "Invoking…";
  btn.disabled = true;
  try {
    const outcome = await api(withIdentity(`/api/actions/${btn.dataset.invoke}/invoke`), post(input), `invoke ${btn.dataset.invoke}`);
    resultEl.classList.add("ok");
    resultEl.textContent = `Success\n${JSON.stringify(outcome.result, null, 2)}`;
    const top = state.breadcrumb[state.breadcrumb.length - 1];
    if (top) state.openRelationships.forEach((rel) => loadRelationship(top.typeName, top.objectId, rel));
  } catch (err) {
    resultEl.classList.add("err");
    resultEl.textContent = `${err.status} ${err.body?.error ?? "Error"}\n${err.message}`;
  } finally {
    btn.disabled = false;
    refreshAudit();
  }
}

// ---------------------------------------------------------------------------
// Query tab
// ---------------------------------------------------------------------------
const QUERY_EXAMPLES = [
  {
    group: "Basics",
    items: [
      ["All aircraft", { type: "airforce.Aircraft" }],
      ["Filter", { type: "airforce.Aircraft", filter: { property: "tailNumber", operator: "eq", value: "AF86-0147" } }],
      ["Paging (limit 1)", { type: "airforce.Aircraft", limit: 1 }],
      ["Boolean filter", { type: "hospital.Appointment", filter: { or: [{ property: "status", operator: "eq", value: "scheduled" }, { property: "status", operator: "eq", value: "completed" }] } }]
    ]
  },
  {
    group: "Includes",
    items: [
      ["Two relationships", { type: "airforce.Aircraft", include: [{ relationship: "components" }, { relationship: "maintenance" }], includeProvenance: true }],
      ["Nested (2 levels)", { type: "airforce.Aircraft", include: [{ relationship: "maintenance", include: [{ relationship: "workOrder" }] }] }],
      ["Include filter", { type: "airforce.Aircraft", include: [{ relationship: "maintenance", filter: { property: "eventType", operator: "eq", value: "unscheduled" } }] }],
      [
        "Hospital: provider → patient",
        {
          type: "hospital.Provider",
          include: [{ relationship: "appointments", include: [{ relationship: "patient", filter: { property: "medicalRecordNumber", operator: "eq", value: "MRN-1001" } }] }]
        }
      ]
    ]
  },
  {
    group: "Rejected by design",
    items: [
      ["Filter on computed", { type: "airforce.Aircraft", filter: { property: "needsAttention", operator: "eq", value: true } }],
      ["Filter on hidden (as Viewer)", { type: "airforce.Aircraft", filter: { property: "maintenanceStatus", operator: "eq", value: "degraded" } }],
      ["Over the page limit", { type: "airforce.Aircraft", limit: 5000 }],
      ["Unknown operator", { type: "airforce.Aircraft", filter: { property: "tailNumber", operator: "like", value: "AF%" } }],
      [
        "Includes too deep",
        { type: "airforce.Aircraft", include: [{ relationship: "maintenance", include: [{ relationship: "workOrder", include: [{ relationship: "a", include: [{ relationship: "b" }] }] }] }] }
      ]
    ]
  }
];

const QUERY_ERROR_HINT = {
  400: "Rejected by input validation, before any policy check or adapter call.",
  403: "Denied by policy, and recorded in the audit log.",
  404: "Not found.",
  429: "Rate limit exceeded for this identity."
};

function initQueryTab() {
  const input = $("#queryInput");
  input.value = JSON.stringify(QUERY_EXAMPLES[0].items[0][1], null, 2);
  $("#queryIdentityNote").textContent = IDENTITY_LABEL[state.identity];

  $("#queryExamples").innerHTML = QUERY_EXAMPLES.map(
    (g, gi) => `<div class="example-group"><span class="example-label">${g.group}</span>${g.items
      .map(([label], ii) => `<button class="btn btn-sm btn-ghost${gi === 2 ? " btn-warnish" : ""}" data-example="${gi}:${ii}">${escapeHtml(label)}</button>`)
      .join("")}</div>`
  ).join("");
  $("#queryExamples").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-example]");
    if (!btn) return;
    const [gi, ii] = btn.dataset.example.split(":").map(Number);
    input.value = JSON.stringify(QUERY_EXAMPLES[gi].items[ii][1], null, 2);
  });

  $("#runQueryBtn").addEventListener("click", () => {
    let query;
    try {
      query = JSON.parse(input.value);
    } catch {
      renderQueryError({ status: "JSON", body: { error: "SyntaxError" }, message: "Invalid JSON: fix the query and try again." });
      return;
    }
    runQuery(query);
  });

  $("#resultView").addEventListener("click", (e) => {
    const btn = e.target.closest(".seg-btn");
    if (!btn) return;
    state.query.view = btn.dataset.view;
    $$(".seg-btn", $("#resultView")).forEach((b) => b.classList.toggle("active", b === btn));
    renderQueryResult();
  });

  document.addEventListener("identity-changed", () => {
    $("#queryIdentityNote").textContent = IDENTITY_LABEL[state.identity];
  });
}

async function runQuery(query) {
  $("#queryOutput").innerHTML = '<div class="empty-state small">Running…</div>';
  $("#resultMeta").innerHTML = "";
  const res = await request(withIdentity("/api/query"), post(query), "query");
  state.query.last = query;
  if (res.ok) {
    state.query.lastResult = { result: res.body, stats: res.stats };
    state.query.lastError = null;
  } else {
    state.query.lastResult = null;
    state.query.lastError = { status: res.status, body: res.body, message: res.body?.message ?? `HTTP ${res.status}` };
  }
  renderQueryResult();
  refreshAudit();
}

function renderQueryResult() {
  if (state.query.lastError) return renderQueryError(state.query.lastError);
  if (!state.query.lastResult) return;
  const { result, stats } = state.query.lastResult;
  const total = stats ? Object.values(stats.calls).reduce((a, b) => a + b, 0) : 0;
  $("#resultMeta").innerHTML = `
    <span class="status-pill s2">200</span>
    <span><strong>${result.items.length}</strong> item${result.items.length === 1 ? "" : "s"}</span>
    ${stats ? `<span class="muted">${total} adapter calls · peak ${stats.peakInFlight} in flight · ${stats.durationMs} ms</span>` : ""}
    ${result.nextCursor ? `<button class="btn btn-sm" id="nextPageBtn">Next page →</button>` : '<span class="muted">last page</span>'}`;
  $("#nextPageBtn")?.addEventListener("click", () => runQuery({ ...state.query.last, cursor: result.nextCursor }));

  const out = $("#queryOutput");
  if (state.query.view === "json") {
    out.innerHTML = `<pre class="json-view">${prettyJson(result)}</pre>`;
  } else {
    out.innerHTML = result.items.length ? `<div class="obj-tree">${result.items.map((o) => renderTreeNode(o, 0)).join("")}</div>` : '<div class="empty-state small">No matching objects visible to this identity.</div>';
  }
}

function isObjectList(value) {
  return Array.isArray(value) && value.every((v) => v && typeof v === "object" && "objectId" in v && "typeName" in v);
}

function renderTreeNode(obj, depth) {
  const scalars = [];
  const nested = [];
  for (const [key, value] of Object.entries(obj.values)) {
    if (isObjectList(value)) nested.push([key, value]);
    else scalars.push([key, value]);
  }
  const chips = scalars
    .slice(0, 8)
    .map(([k, v]) => `<span class="kv"><span class="kk">${escapeHtml(k)}</span> ${escapeHtml(typeof v === "object" ? JSON.stringify(v) : String(v))}</span>`)
    .join("");
  const children = nested
    .map(
      ([rel, items]) => `<details class="tree-rel" ${depth < 1 ? "open" : ""}>
        <summary><span class="rel-name">${escapeHtml(rel)}</span> <span class="count-pill">${items.length}</span></summary>
        ${items.length ? items.map((child) => renderTreeNode(child, depth + 1)).join("") : '<div class="muted small tree-empty">none</div>'}
      </details>`
    )
    .join("");
  return `<div class="tree-node" style="--depth:${depth}">
    <div class="tree-head"><span class="type-name">${escapeHtml(obj.typeName)}</span> <code>${escapeHtml(obj.objectId)}</code></div>
    <div class="kv-row">${chips}</div>
    ${children}
  </div>`;
}

function renderQueryError(err) {
  $("#resultMeta").innerHTML = `<span class="status-pill s${String(err.status)[0]}">${err.status}</span><span class="err-type">${escapeHtml(err.body?.error ?? "Error")}</span>`;
  $("#queryOutput").innerHTML = `<div class="error-box">
    <p class="err-text">${escapeHtml(err.message)}</p>
    ${QUERY_ERROR_HINT[err.status] ? `<p class="muted small">${QUERY_ERROR_HINT[err.status]}</p>` : ""}
  </div>`;
}

function renderLimitChips() {
  const l = state.runtime?.queryLimits;
  if (!l) return;
  $("#limitChips").innerHTML = [
    ["page", `${l.defaultLimit} default, ${l.maxLimit} max`],
    ["includes", `${l.maxIncludes} total, ${l.maxIncludeDepth} deep`],
    ["filters", `${l.maxFilterDepth} deep, ${l.maxFilterConditions} conditions`]
  ]
    .map(([k, v]) => `<span class="limit-chip"><span class="muted">${k}</span> ${v}</span>`)
    .join("");
}

// ---------------------------------------------------------------------------
// Guardrails tab
// ---------------------------------------------------------------------------
function queryAs(identity, query) {
  return request(withIdentity("/api/query", identity), post(query), `query as ${identity}`);
}

const GUARDS = [
  {
    title: "Filtering on a hidden property",
    identity: "viewer",
    why: "Viewers can't read Aircraft.maintenanceStatus. The filter runs before redaction, so answering it would reveal the value.",
    expect: "403, audited",
    run: () => queryAs("viewer", { type: "airforce.Aircraft", filter: { property: "maintenanceStatus", operator: "eq", value: "degraded" } }),
    pass: (r) => r.status === 403
  },
  {
    title: "…the same filter, by someone allowed to read it",
    identity: "maintainer",
    why: "The check is per property and per identity, not a blanket ban on filtering.",
    expect: "200, one aircraft",
    run: () => queryAs("maintainer", { type: "airforce.Aircraft", filter: { property: "maintenanceStatus", operator: "eq", value: "degraded" } }),
    pass: (r) => r.status === 200 && r.body.items.length === 1
  },
  {
    title: "Include filter on a hidden property",
    identity: "clinician vs patient",
    why: "Include filters run after redaction, so they can't probe hidden values: a clinician's filter on medicalRecordNumber matches, a patient's matches nothing.",
    expect: "clinician > 0, patient = 0",
    run: async () => {
      const q = {
        type: "hospital.Provider",
        include: [{ relationship: "appointments", include: [{ relationship: "patient", filter: { property: "medicalRecordNumber", operator: "eq", value: "MRN-1001" } }] }]
      };
      const count = (r) => (r.body?.items ?? []).flatMap((p) => p.values.appointments ?? []).flatMap((a) => a.values.patient ?? []).length;
      const [c, p] = await Promise.all([queryAs("clinician", q), queryAs("patient", q)]);
      return { status: p.status, body: { clinicianMatches: count(c), patientMatches: count(p) } };
    },
    pass: (r) => r.body.clinicianMatches > 0 && r.body.patientMatches === 0
  },
  {
    title: "Filtering on a computed property",
    identity: "maintainer",
    why: "Computed values don't exist until after the adapter filters, so this would silently match nothing. It's refused with a pointer to include filters.",
    expect: "400",
    run: () => queryAs("maintainer", { type: "airforce.Aircraft", filter: { property: "needsAttention", operator: "eq", value: true } }),
    pass: (r) => r.status === 400
  },
  {
    title: "A page bigger than the limit",
    identity: "maintainer",
    why: "Rejected rather than quietly shrunk, so the caller learns the bound.",
    expect: "400",
    run: () => queryAs("maintainer", { type: "airforce.Aircraft", limit: (state.runtime?.queryLimits.maxLimit ?? 1000) + 1 }),
    pass: (r) => r.status === 400
  },
  {
    title: "An unknown filter operator",
    identity: "maintainer",
    why: "The query is checked against its JSON Schema before anything runs.",
    expect: "400",
    run: () => queryAs("maintainer", { type: "airforce.Aircraft", filter: { property: "tailNumber", operator: "like", value: "AF%" } }),
    pass: (r) => r.status === 400
  },
  {
    title: "Includes nested too deep",
    identity: "maintainer",
    why: "Each level multiplies the work, so nesting depth is capped.",
    expect: "400",
    run: () =>
      queryAs("maintainer", {
        type: "airforce.Aircraft",
        include: [{ relationship: "maintenance", include: [{ relationship: "workOrder", include: [{ relationship: "a", include: [{ relationship: "b" }] }] }] }]
      }),
    pass: (r) => r.status === 400
  },
  {
    title: "The same relationship twice",
    identity: "maintainer",
    why: "Results are keyed by relationship name, so the second would silently overwrite the first.",
    expect: "400",
    run: () => queryAs("maintainer", { type: "airforce.Aircraft", include: [{ relationship: "components" }, { relationship: "components" }] }),
    pass: (r) => r.status === 400
  },
  {
    title: "Action input that doesn't match its schema",
    identity: "maintainer",
    why: "assignedTo is required. Input is validated before preconditions or the adapter see it.",
    expect: "400",
    run: () => request(withIdentity("/api/actions/CreateMaintenanceWorkOrder/invoke", "maintainer"), post({ maintenanceEventId: "EVT-9001" }), "invoke as maintainer"),
    pass: (r) => r.status === 400
  },
  {
    title: "…the same bad input, from someone not allowed to act",
    identity: "viewer",
    why: "Authorization is checked first, so the attempt is refused and audited as a denial, not answered with a schema error.",
    expect: "403, audited",
    run: () => request(withIdentity("/api/actions/CreateMaintenanceWorkOrder/invoke", "viewer"), post({ maintenanceEventId: "EVT-9001" }), "invoke as viewer"),
    pass: (r) => r.status === 403
  },
  {
    title: "Valid input, failed business rule",
    identity: "maintainer",
    why: "The precondition checks that the maintenance event exists, so nothing is created.",
    expect: "422",
    run: () => request(withIdentity("/api/actions/CreateMaintenanceWorkOrder/invoke", "maintainer"), post({ maintenanceEventId: "EVT-NOPE", assignedTo: "Demo" }), "invoke as maintainer"),
    pass: (r) => r.status === 422
  },
  {
    title: "One domain's identity reading another domain",
    identity: "maintainer",
    why: "Two domains share one registry and one policy engine, but each domain's policies are its own.",
    expect: "403",
    run: () => request(withIdentity("/api/objects/hospital.Patient/PT-1001", "maintainer"), undefined, "getObject as maintainer"),
    pass: (r) => r.status === 403
  },
  {
    title: "Readable object, redacted property",
    identity: "patient",
    why: "Reading an object and seeing every property of it are separate questions: the record comes back without medicalRecordNumber.",
    expect: "200, field absent",
    run: () => request(withIdentity("/api/objects/hospital.Patient/PT-1001", "patient"), undefined, "getObject as patient"),
    pass: (r) => r.status === 200 && !("medicalRecordNumber" in r.body.values)
  }
];

function renderRuntimeConfig() {
  const r = state.runtime;
  if (!r) return;
  const l = r.queryLimits;
  $("#runtimeConfig").innerHTML = [
    ["Query page", `${l.defaultLimit} by default, at most ${l.maxLimit}`],
    ["Includes", `${l.maxIncludes} in total, ${l.maxIncludeDepth} levels deep`],
    ["Filters", `${l.maxFilterDepth} levels, ${l.maxFilterConditions} conditions`],
    ["Concurrency", `${r.maxConcurrency} adapter calls in flight per request`],
    ["Rate limit", `${r.rateLimit.capacity} burst + ${r.rateLimit.refillPerSecond}/s for ${r.rateLimit.subjectId}`],
    ["Data sources", r.dataSources.join(", ")]
  ]
    .map(([k, v]) => `<div class="cfg"><span class="cfg-k">${k}</span><span class="cfg-v">${escapeHtml(v)}</span></div>`)
    .join("");
  $("#burstSub").textContent = `Fires a burst of reads at once as ${r.rateLimit.subjectId}, which has a budget of ${r.rateLimit.capacity} plus ${r.rateLimit.refillPerSecond} per second.`;
  $("#concurrencySub").textContent = `Runs a query whose includes nest two levels deep. However much it fans out, at most ${r.maxConcurrency} adapter calls run at once.`;
}

function initGuardrails() {
  $("#guardGrid").innerHTML = GUARDS.map(
    (g, i) => `<div class="panel guard-card" data-guard="${i}">
      <div class="guard-head">
        <span class="guard-title">${escapeHtml(g.title)}</span>
        <span class="guard-verdict" data-verdict></span>
      </div>
      <p class="guard-why">${escapeHtml(g.why)}</p>
      <div class="guard-foot">
        <span class="identity-chip">as ${escapeHtml(g.identity)}</span>
        <span class="muted small">expect ${escapeHtml(g.expect)}</span>
        <button class="btn btn-sm" data-run-guard="${i}">Run</button>
      </div>
      <div class="guard-out" hidden></div>
    </div>`
  ).join("");
  $("#guardGrid").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-run-guard]");
    if (btn) runGuard(Number(btn.dataset.runGuard)).then(updateGuardSummary);
  });
  $("#runAllGuards").addEventListener("click", async () => {
    $("#runAllGuards").disabled = true;
    for (let i = 0; i < GUARDS.length; i++) await runGuard(i);
    updateGuardSummary();
    $("#runAllGuards").disabled = false;
  });

  $("#burstCount").addEventListener("input", (e) => {
    $("#burstCountLabel").textContent = e.target.value;
  });
  $("#burstBtn").addEventListener("click", fireBurst);
  $("#concurrencyBtn").addEventListener("click", runConcurrencyDemo);
}

async function runGuard(i) {
  const g = GUARDS[i];
  const card = $(`[data-guard="${i}"]`);
  const verdict = $("[data-verdict]", card);
  const out = $(".guard-out", card);
  verdict.className = "guard-verdict running";
  verdict.textContent = "running";
  const r = await g.run();
  const ok = g.pass(r);
  card.dataset.result = ok ? "pass" : "fail";
  verdict.className = `guard-verdict ${ok ? "pass" : "fail"}`;
  verdict.textContent = ok ? "✓ as designed" : "✗ unexpected";
  out.hidden = false;
  const message =
    r.body?.message ??
    (r.body?.items ? `${r.body.items.length} item(s)` : r.body?.values ? `fields returned: ${Object.keys(r.body.values).join(", ")}` : r.body ? JSON.stringify(r.body) : "");
  out.innerHTML = `<span class="status-pill s${String(r.status)[0]}">${r.status}</span> ${r.body?.error ? `<strong>${escapeHtml(r.body.error)}</strong> ` : ""}<span class="muted">${escapeHtml(message)}</span>`;
  refreshAudit();
}

function updateGuardSummary() {
  const cards = $$(".guard-card[data-result]");
  const passed = cards.filter((c) => c.dataset.result === "pass").length;
  $("#guardSummary").textContent = cards.length ? `${passed}/${cards.length} behaved as designed` : "";
  $("#guardSummary").className = `guard-summary ${cards.length && passed === cards.length ? "all-pass" : ""}`;
}

async function fireBurst() {
  const count = Number($("#burstCount").value);
  $("#burstBtn").disabled = true;
  const r = await api("/api/playground/burst", post({ count }), `burst of ${count}`);
  const meter = $("#burstMeter");
  meter.hidden = false;
  $(".meter-ok", meter).style.flex = String(r.allowed);
  $(".meter-deny", meter).style.flex = String(r.denied);
  $("#burstResult").innerHTML = `<strong class="ok-text">${r.allowed} allowed</strong> · <strong class="err-text">${r.denied} rate-limited</strong> of ${r.count}. The bucket holds ${r.capacity}; fire again right away and fewer get through, wait ${Math.ceil(
    r.capacity / r.refillPerSecond
  )} s and it's full again.`;
  $("#burstBtn").disabled = false;
}

async function runConcurrencyDemo() {
  const query = {
    type: "airforce.Aircraft",
    include: [{ relationship: "components" }, { relationship: "maintenance", include: [{ relationship: "workOrder" }] }]
  };
  const r = await queryAs("maintainer", query);
  const max = state.runtime.maxConcurrency;
  const total = Object.values(r.stats.calls).reduce((a, b) => a + b, 0);
  const viz = $("#budgetViz");
  viz.hidden = false;
  viz.innerHTML = Array.from({ length: max }, (_, i) => `<span class="slot${i < r.stats.peakInFlight ? " used" : ""}"></span>`).join("");
  $("#concurrencyResult").innerHTML = `<strong>${total}</strong> adapter calls across ${Object.keys(r.stats.calls).length} systems, but never more than <strong>${
    r.stats.peakInFlight
  }</strong> at once (budget ${max}). Capped per level instead, three nested levels could have run up to ${max ** 3} at once.`;
  refreshAudit();
}

// ---------------------------------------------------------------------------
// MCP Console tab
// ---------------------------------------------------------------------------
function mcpOps() {
  const token = tokenFor(state.identity);
  const withToken = (uri) => `${uri}${token ? `?token=${token}` : ""}`;
  const as = IDENTITY_LABEL[state.identity];
  return [
    { title: "tools/list", sub: "Actions as tools, plus query with its enforced schema and limits", run: () => api("/api/mcp/tools", undefined, false) },
    { title: "resources/list", sub: "Every browsable Type and object, both domains", run: () => api("/api/mcp/resources", undefined, false) },
    { title: "resources/read — Aircraft", sub: withToken("typesys://objects/airforce.Aircraft/AF86-0147"), run: () => api("/api/mcp/resource", post({ uri: withToken("typesys://objects/airforce.Aircraft/AF86-0147") }), false) },
    { title: "resources/read — Patient", sub: withToken("typesys://objects/hospital.Patient/PT-1001"), run: () => api("/api/mcp/resource", post({ uri: withToken("typesys://objects/hospital.Patient/PT-1001") }), false) },
    {
      title: "resources/read — provenance",
      sub: "…/AF86-0147/provenance/needsAttention (a computed property, traced to its sources)",
      run: () => api("/api/mcp/resource", post({ uri: withToken("typesys://objects/airforce.Aircraft/AF86-0147/provenance/needsAttention") }), false)
    },
    {
      title: "tools/call — query with nested includes",
      sub: `Aircraft → maintenance → workOrder, as ${as}`,
      run: () =>
        api(
          "/api/mcp/tool",
          post({ name: "query", arguments: { type: "airforce.Aircraft", limit: 2, include: [{ relationship: "maintenance", include: [{ relationship: "workOrder" }] }], authToken: token } }),
          false
        )
    },
    {
      title: "tools/call — invalid query",
      sub: "limit 5000: comes back as isError with the validation message",
      run: () => api("/api/mcp/tool", post({ name: "query", arguments: { type: "airforce.Aircraft", limit: 5000, authToken: token } }), false)
    },
    {
      title: "tools/call — CreateMaintenanceWorkOrder",
      sub: `as ${as}; flips with the identity switch`,
      run: () =>
        api(
          "/api/mcp/tool",
          post({ name: "CreateMaintenanceWorkOrder", arguments: { maintenanceEventId: "EVT-9001", assignedTo: "MCP Console Demo", authToken: token } }),
          false
        )
    }
  ];
}

function renderMcpResult(result) {
  const isToolResult = result && Array.isArray(result.content);
  $("#mcpMeta").innerHTML = isToolResult
    ? result.isError
      ? '<span class="status-pill s4">isError</span><span class="muted">A refused or failed call returns normally with isError: true; agents must check it.</span>'
      : '<span class="status-pill s2">ok</span>'
    : "";
  // Tool results carry their payload as a JSON string in content[0].text; show it parsed too.
  let parsed;
  try {
    parsed = isToolResult && result.content[0]?.type === "text" ? JSON.parse(result.content[0].text) : undefined;
  } catch {
    parsed = undefined;
  }
  $("#mcpOutput").innerHTML =
    prettyJson(result) + (parsed !== undefined ? `\n\n<span class="muted">// content[0].text, parsed:</span>\n${prettyJson(parsed)}` : "");
}

// MCP calls pass `false` as the stats label: the in-process MCP transport dispatches outside the
// HTTP request's async context, so the server can't attribute their adapter calls to the request.
async function runMcp(fn) {
  $("#mcpOutput").innerHTML = '<span class="muted">Calling…</span>';
  $("#mcpMeta").innerHTML = "";
  try {
    renderMcpResult(await fn());
  } catch (err) {
    $("#mcpMeta").innerHTML = `<span class="status-pill s4">${err.status ?? "error"}</span>`;
    $("#mcpOutput").innerHTML = `<span class="err-text">${escapeHtml(err.message)}</span>`;
  } finally {
    refreshAudit();
  }
}

async function initMcpTab() {
  const list = $("#mcpOpList");
  const render = () => {
    list.innerHTML = mcpOps()
      .map((op, i) => `<button class="mcp-op" data-op="${i}"><span class="title">${escapeHtml(op.title)}</span><span class="sub">${escapeHtml(op.sub)}</span></button>`)
      .join("");
  };
  list.addEventListener("click", (e) => {
    const btn = e.target.closest(".mcp-op");
    if (btn) runMcp(mcpOps()[Number(btn.dataset.op)].run);
  });
  render();
  document.addEventListener("identity-changed", render);

  const tools = await api("/api/mcp/tools", undefined, false);
  $("#mcpToolName").innerHTML = tools.tools.map((t) => `<option value="${escapeHtml(t.name)}">${escapeHtml(t.name)}</option>`).join("");
  $("#mcpToolName").value = "query";
  $("#mcpToolArgs").value = JSON.stringify({ type: "airforce.MaintenanceEvent", limit: 2, include: [{ relationship: "workOrder" }] }, null, 2);
  $("#mcpToolSend").addEventListener("click", () => {
    let args;
    try {
      args = JSON.parse($("#mcpToolArgs").value || "{}");
    } catch {
      $("#mcpOutput").innerHTML = '<span class="err-text">Arguments must be valid JSON.</span>';
      return;
    }
    const name = $("#mcpToolName").value;
    runMcp(() => api("/api/mcp/tool", post({ name, arguments: { ...args, authToken: tokenFor(state.identity) } }), false));
  });
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
    $("#auditToggle").setAttribute("aria-expanded", String(nowOpen));
  });
  $("#auditFilters").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-decision]");
    if (!btn) return;
    state.audit.decision = btn.dataset.decision;
    $$("[data-decision]").forEach((b) => b.classList.toggle("active", b === btn));
    renderAudit();
  });
  $("#auditSubject").addEventListener("change", (e) => {
    state.audit.subject = e.target.value;
    renderAudit();
  });
  refreshAudit();
  setInterval(refreshAudit, 4000);
}

async function refreshAudit() {
  try {
    state.audit.events = await api("/api/audit", undefined, false);
    renderAudit();
  } catch {
    // Non-fatal — the drawer just stays stale until the next tick.
  }
}

function renderAudit() {
  const { events, decision, subject, seen } = state.audit;
  $("#auditCount").textContent = events.length;

  const subjects = [...new Set(events.map((e) => e.subjectId))].sort();
  const select = $("#auditSubject");
  const current = select.value;
  select.innerHTML = `<option value="">All subjects</option>${subjects.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join("")}`;
  select.value = subjects.includes(current) ? current : "";

  const firstLoad = seen.size === 0;
  const rows = events
    .filter((e) => (decision === "all" || e.decision === decision) && (!subject || e.subjectId === subject))
    .slice(0, 100)
    .map((e) => {
      const fresh = !firstLoad && !seen.has(e.id);
      return `<tr class="${fresh ? "fresh" : ""}">
        <td class="time">${new Date(e.timestamp).toLocaleTimeString()}</td>
        <td class="subject">${escapeHtml(e.subjectId)}</td>
        <td>${escapeHtml(e.action)}</td>
        <td class="resource">${escapeHtml(e.resource.typeName)}${e.resource.objectId ? `/${escapeHtml(e.resource.objectId)}` : ""}${e.resource.propertyPath ? `.${escapeHtml(e.resource.propertyPath)}` : ""}</td>
        <td><span class="decision-pill ${e.decision}">${e.decision}</span></td>
        <td class="reason">${e.reason ? escapeHtml(e.reason) : e.outcome === "success" ? "action executed" : ""}</td>
      </tr>`;
    })
    .join("");
  $("#auditRows").innerHTML = rows || '<tr><td colspan="6" class="muted">No events match.</td></tr>';
  events.forEach((e) => seen.add(e.id));
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
async function init() {
  [state.identities, state.runtime] = await Promise.all([api("/api/identities", undefined, false), api("/api/runtime", undefined, false)]);

  initTabs();
  initIdentitySwitch();
  initQueryTab();
  renderLimitChips();
  initGuardrails();
  renderRuntimeConfig();
  initAuditDrawer();

  $("#typeModalOverlay").addEventListener("click", (e) => {
    if (e.target.id === "typeModalOverlay") closeTypeModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeTypeModal();
  });
  $("#provToggle").addEventListener("change", (e) => {
    state.showSources = e.target.checked;
    if (state.breadcrumb.length) renderCurrentObject();
  });
  $("#loadObjectBtn").addEventListener("click", () => openRoot($("#typePicker").value, $("#objectPicker").value));

  await Promise.all([loadTypes(), initMcpTab()]);
}

init();
