// Marker positions are percentages within mouse-illustration.png (345x500
// natural px), hand-measured against the real G502 X reference art -- see
// CLAUDE.md for how these were derived and verified.
//
// `role` is the semantic identity of a physical button. The backend detects
// which ratbagctl index currently holds each role (from the button's live
// action, not from a hardcoded index table) and reports it in
// GET /api/device as button.role. If it can't tell (role: null), the marker
// shows up as "unknown" and the user can assign it manually below.
// Role/count corrected 2026-07-06 by physical wiggle-test (bound each
// candidate index to a distinct key, watched showkey while pressing).
// "Thumb Button" and "DPI Shift" turned out to be the SAME physical button
// (index 4, factory action 'second-mode') -- GHUB just calls it DPI-Shift,
// but it's freely remappable via ratbagctl/this app, including to a macro.
// x/y calibrated 2026-07-06 by the user dragging markers onto the real
// mouse image (Buttons page -> Calibrate marker positions -> Copy
// calibration JSON). Index Finger 1/2 (indices 8/9, factory actions
// profile-cycle-up/resolution-up) confirmed by the user directly; the
// remaining index (10, factory resolution-down) is still unidentified --
// assign via the manual override in Settings after the wiggle test.
const BUTTON_DEFS = [
  { role: "left", label: "Left Click", x: 31, y: 14 },
  { role: "right", label: "Right Click", x: 62, y: 14 },
  { role: "middle", label: "Middle Click", x: 47, y: 27 },
  { role: "forward", label: "Forward", x: 13, y: 47 },
  { role: "backward", label: "Backward", x: 18, y: 62 },
  { role: "dpiShift", label: "Thumb Button", x: 4, y: 35 },
  { role: "wheelLeft", label: "Wheel Tilt Left", x: 31, y: 27 },
  { role: "wheelRight", label: "Wheel Tilt Right", x: 62, y: 27 },
  { role: "button7", label: "Index Finger 1", x: 16, y: 31 },
  { role: "button8", label: "Index Finger 2", x: 17, y: 22 },
];

// Index 10 (factory action resolution-down) has no corresponding physical
// button on this mouse -- hidden from the UI entirely rather than shown as
// a permanently "unidentified" phantom entry.
const EXCLUDED_BUTTON_INDICES = [10];

const SPECIAL_ACTIONS = [
  "unknown", "doubleclick", "wheel-left", "wheel-right", "wheel-up", "wheel-down",
  "ratchet-mode-switch", "resolution-cycle-up", "resolution-cycle-down",
  "resolution-up", "resolution-down", "resolution-alternate", "resolution-default",
  "profile-cycle-up", "profile-cycle-down", "profile-up", "profile-down",
  "second-mode", "battery-level",
];

const OVERRIDES_KEY = "g502x-role-overrides";
const CALIBRATION_KEY = "g502x-marker-calibration";
let calibrating = false;

function loadCalibration() {
  try {
    return JSON.parse(localStorage.getItem(CALIBRATION_KEY)) || {};
  } catch {
    return {};
  }
}

function saveCalibration(cal) {
  localStorage.setItem(CALIBRATION_KEY, JSON.stringify(cal));
}

function effectiveDefs() {
  const cal = loadCalibration();
  return BUTTON_DEFS.map((d) => ({
    ...d,
    x: cal[d.role] ? cal[d.role].x : d.x,
    y: cal[d.role] ? cal[d.role].y : d.y,
  }));
}

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

let deviceUnreachable = false;

async function api(path, opts) {
  const res = await fetch(path, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // 502s here mean the backend couldn't talk to the mouse at all (as
    // opposed to a 400 for a bad request) -- recheck connection status
    // before throwing, so the calling catch block's showApiError sees a
    // freshly updated deviceUnreachable and shows the status dot instead
    // of a raw error toast.
    if (res.status === 502) {
      try { await loadStatus(); } catch {}
    }
    throw new Error(body.error || `${path} failed (${res.status})`);
  }
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

// Use in place of showToast(e.message, true) for errors from device
// actions: if the mouse is genuinely unreachable, the connection dot
// already communicates that -- an additional error toast per action would
// just be noise.
function showApiError(e) {
  if (deviceUnreachable) return;
  showToast(e.message, true);
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
  const status = await fetch("/api/status").then((r) => r.json());
  const banner = document.getElementById("mock-banner");
  if (status.mode === "mock") {
    banner.hidden = false;
    document.getElementById("mock-reason").textContent = status.reason;
  } else {
    banner.hidden = true;
  }
  const isOk = status.mode !== "mock" && status.connected !== false;
  deviceUnreachable = status.mode !== "mock" && status.connected === false;
  document.getElementById("status-dot").className = "status-dot " + (isOk ? "connected" : "disconnected");
  const modeEl = document.getElementById("status-mode");
  modeEl.textContent = isOk ? "Connected" : "Disconnected";
  modeEl.style.color = isOk ? "#3ecf7a" : "#e5484d";
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
}

// Lighter-weight refreshes for after a single change, instead of
// re-fetching the entire device state (~28 ratbagctl subprocess calls) --
// see /api/buttons and /api/sensitivity in app.py for why this matters.
async function loadButtons() {
  const data = await api("/api/buttons");
  deviceState.button_count = data.button_count;
  deviceState.buttons = data.buttons;
  renderMarkers();
  renderButtonList();
  renderOverridesList();
}

async function loadSensitivity() {
  const data = await api("/api/sensitivity");
  Object.assign(deviceState, data);
  renderSensitivity();
}

function buttonForRole(role) {
  return deviceState.buttons.find((b) => effectiveRole(b) === role);
}

function renderMarkers() {
  const container = document.getElementById("markers");
  container.innerHTML = "";
  for (const def of effectiveDefs()) {
    const button = buttonForRole(def.role);
    const marker = document.createElement("div");
    marker.className = "marker" + (button ? "" : " unknown") + (calibrating ? " calibrating" : "");
    if (button && button.index === selectedIndex) marker.classList.add("selected");
    marker.style.left = def.x + "%";
    marker.style.top = def.y + "%";
    marker.title = def.label + (button ? "" : " (not detected — see Settings)");
    marker.textContent = button ? button.index + 1 : "?";
    if (calibrating) {
      wireMarkerDrag(marker, def.role);
    } else if (button) {
      marker.addEventListener("click", () => selectButton(button.index));
    }
    container.appendChild(marker);
  }
  if (calibrating) renderCalibrationCoords();
}

function wireMarkerDrag(marker, role) {
  marker.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    marker.setPointerCapture(e.pointerId);
    const wrap = document.querySelector(".mouse-image-wrap");

    const onMove = (ev) => {
      const rect = wrap.getBoundingClientRect();
      const x = Math.max(0, Math.min(100, ((ev.clientX - rect.left) / rect.width) * 100));
      const y = Math.max(0, Math.min(100, ((ev.clientY - rect.top) / rect.height) * 100));
      const rx = Math.round(x * 10) / 10;
      const ry = Math.round(y * 10) / 10;
      marker.style.left = rx + "%";
      marker.style.top = ry + "%";
      const cal = loadCalibration();
      cal[role] = { x: rx, y: ry };
      saveCalibration(cal);
      renderCalibrationCoords();
    };
    const onUp = () => {
      marker.removeEventListener("pointermove", onMove);
      marker.removeEventListener("pointerup", onUp);
    };
    marker.addEventListener("pointermove", onMove);
    marker.addEventListener("pointerup", onUp);
  });
}

function renderCalibrationCoords() {
  const el = document.getElementById("calibrate-coords");
  if (!el) return;
  const cal = loadCalibration();
  el.innerHTML = "";
  for (const def of effectiveDefs()) {
    const row = document.createElement("div");
    row.className = "calibrate-row";
    row.innerHTML = `
      <span class="calibrate-role">${def.role}${cal[def.role] ? " •" : ""}</span>
      <label>x <input type="number" step="0.1" min="0" max="100" value="${def.x.toFixed(1)}" data-role="${def.role}" data-axis="x"></label>
      <label>y <input type="number" step="0.1" min="0" max="100" value="${def.y.toFixed(1)}" data-role="${def.role}" data-axis="y"></label>
    `;
    el.appendChild(row);
  }
  el.querySelectorAll("input").forEach((input) => {
    input.addEventListener("change", () => {
      let v = parseFloat(input.value);
      if (Number.isNaN(v)) return;
      v = Math.max(0, Math.min(100, v));
      const role = input.dataset.role;
      const axis = input.dataset.axis;
      const current = effectiveDefs().find((d) => d.role === role);
      const c = loadCalibration();
      c[role] = { x: axis === "x" ? v : current.x, y: axis === "y" ? v : current.y };
      saveCalibration(c);
      renderMarkers();
    });
  });
}

function renderButtonList() {
  const list = document.getElementById("button-list");
  list.innerHTML = "";
  const byRole = new Map(BUTTON_DEFS.map((d) => [d.role, d]));
  const roleOrder = new Map(BUTTON_DEFS.map((d, i) => [d.role, i]));

  const buttons = deviceState.buttons
    .filter((b) => !EXCLUDED_BUTTON_INDICES.includes(b.index))
    .slice()
    .sort((a, b) => {
      const roleA = effectiveRole(a);
      const roleB = effectiveRole(b);
      // Identified buttons sort by their position in BUTTON_DEFS (your
      // custom order); anything unidentified falls after all of those,
      // sorted by raw hardware index.
      const orderA = roleA && roleOrder.has(roleA) ? roleOrder.get(roleA) : BUTTON_DEFS.length + a.index;
      const orderB = roleB && roleOrder.has(roleB) ? roleOrder.get(roleB) : BUTTON_DEFS.length + b.index;
      return orderA - orderB;
    });

  for (const button of buttons) {
    const role = effectiveRole(button);
    const def = role ? byRole.get(role) : null;
    const row = document.createElement("div");
    row.className = "button-row" + (button.index === selectedIndex ? " selected" : "");
    row.innerHTML = `
      <div>
        <div class="button-row-label">${def ? def.label : `Button ${button.index + 1}`}${def ? "" : '<span class="badge-unknown">unidentified</span>'}</div>
        <div class="button-row-sub">Index ${button.index + 1}</div>
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
    if (EXCLUDED_BUTTON_INDICES.includes(button.index)) continue;
    const row = document.createElement("div");
    row.className = "override-row";
    const options = ['<option value="">(auto-detected)</option>']
      .concat(BUTTON_DEFS.map((d) => `<option value="${d.role}">${d.label}</option>`));
    row.innerHTML = `
      <span style="width:90px;">Index ${button.index + 1}</span>
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
  document.getElementById("editor-title").textContent = def ? def.label : `Button ${index + 1}`;
  document.getElementById("editor-error").hidden = true;

  const typeSelect = document.getElementById("action-type");
  const currentType = button.action_type === "none" ? "disabled" : button.action_type;
  const isMacro = currentType === "macro";
  document.getElementById("editor-macro-note").hidden = !isMacro;
  typeSelect.value = isMacro ? "button" : currentType;
  renderActionValueField(button);
  typeSelect.onchange = () => {
    document.getElementById("editor-macro-note").hidden = true;
    renderActionValueField(button);
  };
}

function renderActionValueField(button) {
  const wrap = document.getElementById("action-value-wrap");
  const type = document.getElementById("action-type").value;
  wrap.innerHTML = "";
  if (type === "button") {
    wrap.innerHTML = `
      <label class="field-label">Target mouse button number (1=left, 2=right, 3=middle, 4=forward, 5=backward on this mouse, ...)</label>
      <input type="number" id="action-value" min="1" value="${button.action_type === "button" ? button.action_value : 1}">
    `;
  } else if (type === "key") {
    wrap.innerHTML = `
      <label class="field-label">Key name (Linux input event code, e.g. KEY_A, KEY_F13)</label>
      <div style="display:flex; gap:8px;">
        <input type="text" id="action-value" style="flex:1;" value="${button.action_type === "key" ? button.action_value : "KEY_"}">
        <button type="button" class="btn-secondary" id="action-value-capture" style="margin:0; flex-shrink:0;">Press key&hellip;</button>
      </div>
    `;
    document.getElementById("action-value-capture").addEventListener("click", () => {
      openKeyCaptureModal((keyName) => {
        document.getElementById("action-value").value = keyName;
      });
    });
  } else if (type === "special") {
    wrap.innerHTML = `
      <label class="field-label">Special action</label>
      <select id="action-value">
        ${SPECIAL_ACTIONS.map((s) => `<option value="${s}" ${button.action_value === s ? "selected" : ""}>${s}</option>`).join("")}
      </select>
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
    if (!body.value || !body.value.trim()) {
      errorEl.textContent = "Value cannot be empty.";
      errorEl.hidden = false;
      return;
    }
  }

  try {
    await api(`/api/button/${selectedIndex}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    showToast("Button updated");
    await loadButtons();
    openEditor(selectedIndex);
  } catch (e) {
    if (deviceUnreachable) return;
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
        await loadSensitivity();
      } catch (e) {
        showApiError(e);
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
        await loadSensitivity();
      } catch (e) {
        showApiError(e);
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
        await loadSensitivity();
      } catch (e) {
        showApiError(e);
      }
    }, 250);
  };

  numberEl.addEventListener("change", () => commit(parseInt(numberEl.value, 10)));
  sliderEl.addEventListener("input", () => {
    numberEl.value = sliderEl.value;
  });
  sliderEl.addEventListener("change", () => commit(parseInt(sliderEl.value, 10)));
}

// DOM KeyboardEvent.code -> Linux input-event-code, for the key-capture modal.
const KEYCODE_MAP = {
  KeyA: "KEY_A", KeyB: "KEY_B", KeyC: "KEY_C", KeyD: "KEY_D", KeyE: "KEY_E", KeyF: "KEY_F",
  KeyG: "KEY_G", KeyH: "KEY_H", KeyI: "KEY_I", KeyJ: "KEY_J", KeyK: "KEY_K", KeyL: "KEY_L",
  KeyM: "KEY_M", KeyN: "KEY_N", KeyO: "KEY_O", KeyP: "KEY_P", KeyQ: "KEY_Q", KeyR: "KEY_R",
  KeyS: "KEY_S", KeyT: "KEY_T", KeyU: "KEY_U", KeyV: "KEY_V", KeyW: "KEY_W", KeyX: "KEY_X",
  KeyY: "KEY_Y", KeyZ: "KEY_Z",
  Digit0: "KEY_0", Digit1: "KEY_1", Digit2: "KEY_2", Digit3: "KEY_3", Digit4: "KEY_4",
  Digit5: "KEY_5", Digit6: "KEY_6", Digit7: "KEY_7", Digit8: "KEY_8", Digit9: "KEY_9",
  F1: "KEY_F1", F2: "KEY_F2", F3: "KEY_F3", F4: "KEY_F4", F5: "KEY_F5", F6: "KEY_F6",
  F7: "KEY_F7", F8: "KEY_F8", F9: "KEY_F9", F10: "KEY_F10", F11: "KEY_F11", F12: "KEY_F12",
  Space: "KEY_SPACE", Enter: "KEY_ENTER", Escape: "KEY_ESC", Tab: "KEY_TAB",
  Backspace: "KEY_BACKSPACE", CapsLock: "KEY_CAPSLOCK",
  ShiftLeft: "KEY_LEFTSHIFT", ShiftRight: "KEY_RIGHTSHIFT",
  ControlLeft: "KEY_LEFTCTRL", ControlRight: "KEY_RIGHTCTRL",
  AltLeft: "KEY_LEFTALT", AltRight: "KEY_RIGHTALT",
  MetaLeft: "KEY_LEFTMETA", MetaRight: "KEY_RIGHTMETA",
  ArrowUp: "KEY_UP", ArrowDown: "KEY_DOWN", ArrowLeft: "KEY_LEFT", ArrowRight: "KEY_RIGHT",
  Home: "KEY_HOME", End: "KEY_END", PageUp: "KEY_PAGEUP", PageDown: "KEY_PAGEDOWN",
  Insert: "KEY_INSERT", Delete: "KEY_DELETE",
  Minus: "KEY_MINUS", Equal: "KEY_EQUAL",
  BracketLeft: "KEY_LEFTBRACE", BracketRight: "KEY_RIGHTBRACE",
  Backslash: "KEY_BACKSLASH", Semicolon: "KEY_SEMICOLON", Quote: "KEY_APOSTROPHE",
  Comma: "KEY_COMMA", Period: "KEY_DOT", Slash: "KEY_SLASH", Backquote: "KEY_GRAVE",
};

function openKeyCaptureModal(onCapture) {
  const modal = document.getElementById("key-capture-modal");
  const box = document.getElementById("key-capture-box");
  modal.hidden = false;
  box.focus();

  const onKeyDown = (e) => {
    e.preventDefault();
    if (e.key === "Escape") {
      closeKeyCaptureModal();
      return;
    }
    const keyName = KEYCODE_MAP[e.code];
    if (!keyName) {
      showToast(`Unsupported key: ${e.code}`, true);
      return;
    }
    onCapture(keyName);
    closeKeyCaptureModal();
  };

  box.addEventListener("keydown", onKeyDown);
  box._onKeyDown = onKeyDown;
}

function closeKeyCaptureModal() {
  const modal = document.getElementById("key-capture-modal");
  const box = document.getElementById("key-capture-box");
  if (box._onKeyDown) box.removeEventListener("keydown", box._onKeyDown);
  modal.hidden = true;
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

  const calToggle = document.getElementById("calibrate-toggle");
  const calControls = document.getElementById("calibrate-controls");
  calToggle.addEventListener("click", () => {
    calibrating = !calibrating;
    calToggle.textContent = calibrating ? "Done calibrating" : "Calibrate marker positions";
    calControls.hidden = !calibrating;
    renderMarkers();
  });
  document.getElementById("calibrate-copy").addEventListener("click", () => {
    const json = JSON.stringify(
      effectiveDefs().map((d) => ({ role: d.role, label: d.label, x: d.x, y: d.y })),
      null,
      2
    );
    navigator.clipboard.writeText(json).then(
      () => showToast("Calibration JSON copied"),
      () => showToast("Copy failed — select the text below manually", true)
    );
  });
  document.getElementById("calibrate-reset").addEventListener("click", () => {
    localStorage.removeItem(CALIBRATION_KEY);
    renderMarkers();
    showToast("Marker positions reset to defaults");
  });

  document.getElementById("key-capture-cancel").addEventListener("click", closeKeyCaptureModal);

  document.getElementById("restore-defaults-btn").addEventListener("click", async () => {
    if (!confirm("Reset every button to its factory action? This can't be undone.")) return;
    try {
      await api("/api/buttons/restore-defaults", { method: "POST" });
      showToast("Buttons restored to factory defaults");
      await loadButtons();
    } catch (e) {
      showApiError(e);
    }
  });

  document.getElementById("clear-overrides-btn").addEventListener("click", () => {
    if (!confirm("Clear all manual label overrides? Labels will fall back to auto-detection.")) return;
    localStorage.removeItem(OVERRIDES_KEY);
    renderMarkers();
    renderButtonList();
    renderOverridesList();
    showToast("Overrides cleared");
  });

  try {
    await loadStatus();
    await loadDevice();
  } catch (e) {
    showApiError(e);
  }

  // Keep the connection dot live even with no user interaction -- e.g. the
  // wireless mouse going out of range/off, or coming back.
  setInterval(() => { loadStatus().catch(() => {}); }, 5000);
}

main();
