// Marker positions are percentages within mouse-illustration.png (345x500
// natural px), hand-measured against the real G502 X reference art -- see
// CLAUDE.md for how these were derived and verified.
//
// `role` is the semantic identity of a physical button. The backend detects
// which ratbagctl index currently holds each role (from the button's live
// action, not from a hardcoded index table) and reports it in
// GET /api/device as button.role. If it can't tell (role: null), the marker
// shows up as "unknown" and the user can assign it manually below.
const BUTTON_DEFS = [
  { role: "left", label: "Left Click", x: 36.2, y: 14.0 },
  { role: "right", label: "Right Click", x: 66.7, y: 14.0 },
  { role: "middle", label: "Middle Click", x: 50.7, y: 37.0 },
  { role: "wheelLeft", label: "Wheel Tilt Left", x: 25.5, y: 26.2 },
  { role: "wheelRight", label: "Wheel Tilt Right", x: 77.4, y: 26.2 },
  { role: "back", label: "Back (G7)", x: 13.0, y: 30.0 },
  { role: "forward", label: "Forward (G8)", x: 13.9, y: 22.6 },
  { role: "g9", label: "DPI Shift / Sniper (G9)", x: 50.7, y: 45.6 },
];

const SPECIAL_ACTIONS = [
  "unknown", "doubleclick", "wheel-left", "wheel-right", "wheel-up", "wheel-down",
  "ratchet-mode-switch", "resolution-cycle-up", "resolution-cycle-down",
  "resolution-up", "resolution-down", "resolution-alternate", "resolution-default",
  "profile-cycle-up", "profile-cycle-down", "profile-up", "profile-down",
  "second-mode", "battery-level",
];

const OVERRIDES_KEY = "g502x-role-overrides";

function loadOverrides() {
  try {
    return JSON.parse(localStorage.getItem(OVERRIDES_KEY)) || {};
  } catch {
    return {};
  }
}

function saveOverrides(overrides) {
  localStorage.setItem(OVERRIDES_KEY, JSON.stringify(overrides));
}

let deviceState = null;
let selectedIndex = null;

async function api(path, opts) {
  const res = await fetch(path, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `${path} failed (${res.status})`);
  return body;
}

function showToast(message, isError) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.hidden = false;
  el.className = "toast" + (isError ? " error" : "");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { el.hidden = true; }, 3500);
}

function effectiveRole(button) {
  const overrides = loadOverrides();
  if (overrides[button.index]) return overrides[button.index];
  return button.role;
}

function actionLabel(button) {
  switch (button.action_type) {
    case "none": return "Unassigned";
    case "button": return `Mouse button ${button.action_value}`;
    case "key": return `Key: ${button.action_value}`;
    case "special": return `Special: ${button.action_value}`;
    case "macro": return `Macro: ${button.action_value}`;
    default: return button.action_type;
  }
}

async function loadStatus() {
  const status = await api("/api/status");
  const banner = document.getElementById("mock-banner");
  if (status.mode === "mock") {
    banner.hidden = false;
    document.getElementById("mock-reason").textContent = status.reason;
  } else {
    banner.hidden = true;
  }
  document.getElementById("status-mode").textContent = status.mode === "mock" ? "Mock" : "Real";
  document.getElementById("status-note").textContent = status.reason;
  document.getElementById("settings-status").textContent =
    `${status.mode === "mock" ? "Mock device" : "Real device"} (${status.device_id}). ${status.reason}`;
  return status;
}

async function loadDevice() {
  deviceState = await api("/api/device");
  document.getElementById("device-name").textContent = deviceState.name;
  renderMarkers();
  renderButtonList();
  renderOverridesList();
  renderSensitivity();
  renderProfiles();
}

function buttonForRole(role) {
  return deviceState.buttons.find((b) => effectiveRole(b) === role);
}

function renderMarkers() {
  const container = document.getElementById("markers");
  container.innerHTML = "";
  for (const def of BUTTON_DEFS) {
    const button = buttonForRole(def.role);
    const marker = document.createElement("div");
    marker.className = "marker" + (button ? "" : " unknown");
    if (button && button.index === selectedIndex) marker.classList.add("selected");
    marker.style.left = def.x + "%";
    marker.style.top = def.y + "%";
    marker.title = def.label + (button ? "" : " (not detected — see Settings)");
    marker.textContent = button ? button.index : "?";
    if (button) {
      marker.addEventListener("click", () => selectButton(button.index));
    }
    container.appendChild(marker);
  }
}

function renderButtonList() {
  const list = document.getElementById("button-list");
  list.innerHTML = "";
  const byRole = new Map(BUTTON_DEFS.map((d) => [d.role, d]));

  for (const button of deviceState.buttons) {
    const role = effectiveRole(button);
    const def = role ? byRole.get(role) : null;
    const row = document.createElement("div");
    row.className = "button-row" + (button.index === selectedIndex ? " selected" : "");
    row.innerHTML = `
      <div>
        <div class="button-row-label">${def ? def.label : `Button ${button.index}`}${def ? "" : '<span class="badge-unknown">unidentified</span>'}</div>
        <div class="button-row-sub">Index ${button.index}</div>
      </div>
      <div class="button-row-action">${actionLabel(button)}</div>
    `;
    row.addEventListener("click", () => selectButton(button.index));
    list.appendChild(row);
  }
}

function renderOverridesList() {
  const container = document.getElementById("overrides-list");
  container.innerHTML = "";
  const overrides = loadOverrides();
  for (const button of deviceState.buttons) {
    const row = document.createElement("div");
    row.className = "override-row";
    const options = ['<option value="">(auto-detected)</option>']
      .concat(BUTTON_DEFS.map((d) => `<option value="${d.role}">${d.label}</option>`));
    row.innerHTML = `
      <span style="width:90px;">Index ${button.index}</span>
      <select data-index="${button.index}">${options.join("")}</select>
    `;
    const select = row.querySelector("select");
    select.value = overrides[button.index] || "";
    select.addEventListener("change", () => {
      const o = loadOverrides();
      if (select.value) {
        o[button.index] = select.value;
      } else {
        delete o[button.index];
      }
      saveOverrides(o);
      renderMarkers();
      renderButtonList();
    });
    container.appendChild(row);
  }
}

function selectButton(index) {
  selectedIndex = index;
  renderMarkers();
  renderButtonList();
  openEditor(index);
}

function openEditor(index) {
  const button = deviceState.buttons.find((b) => b.index === index);
  const editor = document.getElementById("button-editor");
  editor.hidden = false;
  const role = effectiveRole(button);
  const def = BUTTON_DEFS.find((d) => d.role === role);
  document.getElementById("editor-title").textContent = def ? def.label : `Button ${index}`;
  document.getElementById("editor-error").hidden = true;

  const typeSelect = document.getElementById("action-type");
  typeSelect.value = button.action_type === "none" ? "disabled" : button.action_type;
  renderActionValueField(button);
  typeSelect.onchange = () => renderActionValueField(button);
}

function renderActionValueField(button) {
  const wrap = document.getElementById("action-value-wrap");
  const type = document.getElementById("action-type").value;
  wrap.innerHTML = "";
  if (type === "button") {
    wrap.innerHTML = `
      <label class="field-label">Target mouse button number (1=left, 2=right, 3=middle, 4=back, 5=forward, ...)</label>
      <input type="number" id="action-value" min="1" value="${button.action_type === "button" ? button.action_value : 1}">
    `;
  } else if (type === "key") {
    wrap.innerHTML = `
      <label class="field-label">Key name (Linux input event code, e.g. KEY_A, KEY_F13)</label>
      <input type="text" id="action-value" value="${button.action_type === "key" ? button.action_value : "KEY_"}">
    `;
  } else if (type === "special") {
    wrap.innerHTML = `
      <label class="field-label">Special action</label>
      <select id="action-value">
        ${SPECIAL_ACTIONS.map((s) => `<option value="${s}" ${button.action_value === s ? "selected" : ""}>${s}</option>`).join("")}
      </select>
    `;
  } else if (type === "macro") {
    wrap.innerHTML = `
      <label class="field-label">Macro (space-separated: KEY_A, +KEY_A press, -KEY_A release, t300 wait ms)</label>
      <input type="text" id="action-value" placeholder="KEY_A t50 -KEY_A" value="${button.action_type === "macro" ? "" : ""}">
    `;
  } else {
    wrap.innerHTML = `<p class="subtitle" style="margin:8px 0 0;">This button will be disabled.</p>`;
  }
}

async function applyAction() {
  const type = document.getElementById("action-type").value;
  const valueEl = document.getElementById("action-value");
  const errorEl = document.getElementById("editor-error");
  errorEl.hidden = true;

  const body = { type };
  if (type !== "disabled") {
    body.value = valueEl.value;
  }

  try {
    await api(`/api/button/${selectedIndex}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    showToast("Button updated");
    await loadDevice();
    openEditor(selectedIndex);
  } catch (e) {
    errorEl.textContent = e.message;
    errorEl.hidden = false;
  }
}

function renderSensitivity() {
  const numberEl = document.getElementById("dpi-number");
  const sliderEl = document.getElementById("dpi-slider");
  const min = deviceState.dpi_min || 100;
  const max = deviceState.dpi_max || 26000;
  numberEl.value = deviceState.dpi;
  sliderEl.min = min;
  sliderEl.max = max;
  sliderEl.value = deviceState.dpi;
  document.getElementById("dpi-min-label").textContent = min;
  document.getElementById("dpi-max-label").textContent = max;

  const stagesEl = document.getElementById("dpi-stages");
  stagesEl.innerHTML = "";
  for (const res of deviceState.resolutions) {
    const chip = document.createElement("div");
    chip.className = "stage-chip" + (res.active ? " active" : "");
    chip.textContent = `${res.dpi} dpi`;
    chip.addEventListener("click", async () => {
      try {
        await api(`/api/resolution/${res.index}/active`, { method: "POST" });
        await loadDevice();
      } catch (e) {
        showToast(e.message, true);
      }
    });
    stagesEl.appendChild(chip);
  }

  const rateEl = document.getElementById("rate-options");
  rateEl.innerHTML = "";
  for (const rate of deviceState.rate_options) {
    const chip = document.createElement("div");
    chip.className = "stage-chip" + (rate === deviceState.rate ? " active" : "");
    chip.textContent = `${rate} Hz`;
    chip.addEventListener("click", async () => {
      try {
        await api("/api/rate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ value: rate }),
        });
        await loadDevice();
      } catch (e) {
        showToast(e.message, true);
      }
    });
    rateEl.appendChild(chip);
  }
}

let dpiDebounce;
function wireDpiInputs() {
  const numberEl = document.getElementById("dpi-number");
  const sliderEl = document.getElementById("dpi-slider");

  const commit = (value) => {
    clearTimeout(dpiDebounce);
    dpiDebounce = setTimeout(async () => {
      try {
        await api("/api/dpi", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ value }),
        });
        await loadDevice();
      } catch (e) {
        showToast(e.message, true);
      }
    }, 250);
  };

  numberEl.addEventListener("change", () => commit(parseInt(numberEl.value, 10)));
  sliderEl.addEventListener("input", () => {
    numberEl.value = sliderEl.value;
  });
  sliderEl.addEventListener("change", () => commit(parseInt(sliderEl.value, 10)));
}

function renderProfiles() {
  const list = document.getElementById("profiles-list");
  list.innerHTML = "";
  for (const profile of deviceState.profiles) {
    const row = document.createElement("div");
    row.className = "profile-row" + (profile.index === deviceState.profile_active ? " active" : "");
    row.innerHTML = `
      <div>
        <div class="profile-name">${profile.name}</div>
        <div class="profile-index">Profile ${profile.index}</div>
      </div>
    `;
    row.addEventListener("click", async () => {
      try {
        await api("/api/profile", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ index: profile.index }),
        });
        await loadDevice();
      } catch (e) {
        showToast(e.message, true);
      }
    });
    list.appendChild(row);
  }
}

function wireNav() {
  const items = document.querySelectorAll(".nav-item");
  items.forEach((item) => {
    item.addEventListener("click", () => {
      items.forEach((i) => i.classList.remove("active"));
      item.classList.add("active");
      document.querySelectorAll(".section").forEach((s) => { s.hidden = true; });
      document.getElementById(`section-${item.dataset.section}`).hidden = false;
    });
  });
}

async function main() {
  wireNav();
  wireDpiInputs();
  document.getElementById("action-apply").addEventListener("click", applyAction);
  document.getElementById("editor-close").addEventListener("click", () => {
    document.getElementById("button-editor").hidden = true;
    selectedIndex = null;
    renderMarkers();
    renderButtonList();
  });

  try {
    await loadStatus();
    await loadDevice();
  } catch (e) {
    showToast(e.message, true);
  }
}

main();
