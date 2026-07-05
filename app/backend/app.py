"""Flask backend for the G502 X control app.

Wraps ratbagctl (real hardware via ratbagd) with an automatic mock fallback
so the UI is developable/testable without a physical mouse attached.
"""
from __future__ import annotations

import functools
import os
from dataclasses import asdict

from flask import Flask, jsonify, request, send_from_directory

from ratbag_client import (
    MockRatbagClient,
    RatbagCtlError,
    RealRatbagClient,
)

FRONTEND_DIR = os.path.join(os.path.dirname(__file__), "..", "frontend")

app = Flask(__name__, static_folder=FRONTEND_DIR, static_url_path="")

MODE = os.environ.get("RATBAG_MODE", "auto")  # auto | real | mock

client = None
device_id = None
device_name = None
mode_reason = ""


def _init_client():
    global client, device_id, device_name, mode_reason

    if MODE == "mock":
        client = MockRatbagClient()
        d = client.list_devices()[0]
        device_id, device_name = d["id"], d["name"]
        mode_reason = "RATBAG_MODE=mock"
        return

    if MODE in ("auto", "real"):
        if RealRatbagClient.is_available():
            real = RealRatbagClient()
            try:
                devices = real.list_devices()
            except RatbagCtlError as e:
                devices = []
                mode_reason = f"ratbagctl list failed: {e}"
            if devices:
                client = real
                device_id, device_name = devices[0]["id"], devices[0]["name"]
                mode_reason = f"found device via ratbagctl: {devices[0]['name']}"
                return
            if MODE == "real":
                raise RuntimeError(
                    "RATBAG_MODE=real but no devices found by `ratbagctl list`. "
                    "Is ratbagd running and is the mouse detected? "
                    "Check with: sudo systemctl status ratbagd && ratbagctl list"
                )
            mode_reason = mode_reason or "ratbagctl present but no devices found"
        elif MODE == "real":
            raise RuntimeError(
                "RATBAG_MODE=real but the `ratbagctl` binary was not found on PATH."
            )
        else:
            mode_reason = "ratbagctl binary not found"

    # fall back to mock
    client = MockRatbagClient()
    d = client.list_devices()[0]
    device_id, device_name = d["id"], d["name"]


_init_client()
IS_MOCK = isinstance(client, MockRatbagClient)


def _refresh_device_id() -> bool:
    """ratbagd assigns each wireless *connection* a random two-word nickname
    (e.g. 'crooning-chinchilla') used to address it via ratbagctl -- this is
    not a stable hardware identifier, and has been observed to change on
    reconnect. Re-resolve it by matching the device's actual name (stable)
    via `ratbagctl list`. Returns True if a different id was found."""
    global device_id, mode_reason
    if IS_MOCK:
        return False
    try:
        devices = RealRatbagClient().list_devices()
    except RatbagCtlError:
        return False
    for d in devices:
        if d["name"] == device_name and d["id"] != device_id:
            device_id = d["id"]
            mode_reason = f"reconnected via ratbagctl: {d['name']} (id changed to {d['id']})"
            return True
    return False


def with_device_reconnect(view_func):
    """Wrap a route so a stale device_id (from the nickname changing on
    wireless reconnect) is transparently recovered from instead of every
    subsequent request 502ing until the process is restarted."""

    @functools.wraps(view_func)
    def wrapper(*args, **kwargs):
        try:
            return view_func(*args, **kwargs)
        except RatbagCtlError as e:
            if _refresh_device_id():
                try:
                    return view_func(*args, **kwargs)
                except RatbagCtlError as e2:
                    return jsonify({"error": str(e2)}), 502
            return jsonify({"error": str(e)}), 502

    return wrapper


# --- Role detection ---------------------------------------------------------
#
# There is no static table mapping ratbagctl button index -> physical button
# for the G502 X: libratbag enumerates buttons from the live device's HID++
# control-ID list, and that order is only known by asking the device itself.
# Instead of hardcoding a guess, we infer each button's physical identity from
# its *current* action, using conventions that hold regardless of index order:
#   - buttons mapped to themselves (button N -> action "button N") are the
#     main click buttons, by standard USB HID mouse button numbering
#     (1=left, 2=right, 3=middle, 4=back, 5=forward)
#   - "wheel-left" / "wheel-right" specials are the wheel tilt buttons
#   - a resolution/second-mode special behind the wheel is G9 (DPI shift /
#     sniper)
# Anything that doesn't match a rule is left unidentified rather than guessed,
# and the frontend lets the user assign/correct it manually.

_BUTTON_NUMBER_TO_ROLE = {
    "1": "left",
    "2": "right",
    "3": "middle",
    # Swapped from the standard HID convention (4=back, 5=forward) on
    # 2026-07-06 at the user's explicit request -- back/forward navigation
    # in their actual setup responds correctly this way round, so this
    # reflects real confirmed behavior, not a guess.
    "4": "forward",
    "5": "backward",
}

_SPECIAL_TO_ROLE = {
    "wheel-left": "wheelLeft",
    "wheel-right": "wheelRight",
    "resolution-cycle-up": "dpiShift",
    "resolution-cycle-down": "dpiShift",
    "resolution-alternate": "dpiShift",
    "second-mode": "dpiShift",
}


def detect_roles(buttons) -> dict[int, dict]:
    roles: dict[int, dict] = {}
    claimed_roles: set[str] = set()

    for b in buttons:
        role = None
        if b.action_type == "button" and b.action_value in _BUTTON_NUMBER_TO_ROLE:
            role = _BUTTON_NUMBER_TO_ROLE[b.action_value]
        elif b.action_type == "special" and b.action_value in _SPECIAL_TO_ROLE:
            role = _SPECIAL_TO_ROLE[b.action_value]

        if role and role not in claimed_roles:
            roles[b.index] = {"role": role, "confidence": "detected"}
            claimed_roles.add(role)
        else:
            roles[b.index] = {"role": None, "confidence": "unknown"}

    return roles


# ratbagctl has no device-level "factory reset" command, so this is a
# hardcoded snapshot of this specific G502 X's actual factory button
# actions, captured directly from `ratbagctl button N get` before any
# remapping happened.
FACTORY_BUTTON_DEFAULTS = {
    0: ("button", "1"),
    1: ("button", "2"),
    2: ("button", "3"),
    3: ("button", "4"),
    4: ("special", "second-mode"),
    5: ("button", "5"),
    6: ("special", "wheel-left"),
    7: ("special", "wheel-right"),
    8: ("special", "profile-cycle-up"),
    9: ("special", "resolution-up"),
    10: ("special", "resolution-down"),
}


def _apply_button_default(index: int, action_type: str, value: str, profile: int | None = None) -> None:
    if action_type == "button":
        client.set_button_button(device_id, index, int(value), profile=profile)
    elif action_type == "special":
        client.set_button_special(device_id, index, value, profile=profile)
    elif action_type == "key":
        client.set_button_key(device_id, index, value, profile=profile)
    elif action_type == "disabled":
        client.set_button_disabled(device_id, index, profile=profile)


def get_profiles(max_probe: int = 8) -> list[dict]:
    """ratbagctl has no 'profile count' command, so profiles are enumerated
    by probing indices from 0 until one fails (profiles are contiguous)."""
    profiles = []
    for i in range(max_probe):
        try:
            name = client.get_profile_name(device_id, i)
        except RatbagCtlError:
            break
        profiles.append({"index": i, "name": name})
    return profiles


def button_to_dict(b) -> dict:
    return {
        "index": b.index,
        "action_type": b.action_type,
        "action_value": b.action_value,
    }


@app.get("/api/status")
def api_status():
    """Does a live check every call (not just cached startup state) so the
    UI's connection indicator reflects reality -- e.g. the wireless mouse
    being off/out of range/unplugged right now, not just at process start."""
    connected = True
    reason = mode_reason
    if not IS_MOCK:
        try:
            devices = RealRatbagClient().list_devices()
        except RatbagCtlError:
            devices = []
        connected = any(d["name"] == device_name for d in devices)
        if not connected:
            reason = "device not found -- check power, pairing, and receiver connection"

    return jsonify(
        {
            "mode": "mock" if IS_MOCK else "real",
            "connected": connected,
            "reason": reason,
            "device_id": device_id,
        }
    )


@app.get("/api/device")
@with_device_reconnect
def api_device():
    """Full snapshot -- used once on page load. Everything else re-fetches
    only the piece that actually changed (see /api/buttons, /api/sensitivity
    below); each ratbagctl call is its own subprocess + D-Bus/wireless round
    trip (~80-100ms), and this endpoint alone used to make ~28 of them."""
    state = client.get_device_state(device_id)
    dpi = client.get_dpi(device_id)

    roles = detect_roles(state.buttons)
    buttons = []
    for b in state.buttons:
        d = button_to_dict(b)
        d.update(roles[b.index])
        buttons.append(d)

    return jsonify(
        {
            "name": state.name,
            "button_count": state.button_count,
            "buttons": buttons,
            "resolutions": [asdict(r) for r in state.resolutions],
            "dpi": dpi,
            "dpi_min": state.dpi_min,
            "dpi_max": state.dpi_max,
            "rate": state.rate,
            "rate_options": state.rate_options,
        }
    )


@app.get("/api/buttons")
@with_device_reconnect
def api_buttons():
    """Lightweight refresh for after a single button edit -- skips
    resolutions/rate/dpi entirely (~12 ratbagctl calls instead of ~28)."""
    buttons_raw = client.get_all_buttons(device_id)

    roles = detect_roles(buttons_raw)
    buttons = []
    for b in buttons_raw:
        d = button_to_dict(b)
        d.update(roles[b.index])
        buttons.append(d)

    return jsonify({"button_count": len(buttons_raw), "buttons": buttons})


@app.get("/api/sensitivity")
@with_device_reconnect
def api_sensitivity():
    """Lightweight refresh for after a DPI/rate/resolution change -- skips
    the 11 per-button reads entirely."""
    dpi = client.get_dpi(device_id)
    resolutions = client.get_resolutions(device_id)
    rate = client.get_rate(device_id)
    rate_options = client.get_rate_options(device_id)

    return jsonify(
        {
            "dpi": dpi,
            "dpi_min": None,
            "dpi_max": None,
            "resolutions": [asdict(r) for r in resolutions],
            "rate": rate,
            "rate_options": rate_options,
        }
    )


@app.post("/api/button/<int:index>")
@with_device_reconnect
def api_set_button(index: int):
    body = request.get_json(force=True, silent=True) or {}
    action_type = body.get("type")
    try:
        if action_type == "button":
            client.set_button_button(device_id, index, int(body["value"]))
        elif action_type == "key":
            client.set_button_key(device_id, index, str(body["value"]))
        elif action_type == "special":
            client.set_button_special(device_id, index, str(body["value"]))
        elif action_type == "macro":
            tokens = str(body["value"]).split()
            if not tokens:
                return jsonify({"error": "macro cannot be empty"}), 400
            client.set_button_macro(device_id, index, tokens)
        elif action_type == "disabled":
            client.set_button_disabled(device_id, index)
        else:
            return jsonify({"error": f"unknown action type {action_type!r}"}), 400
    except (KeyError, ValueError) as e:
        return jsonify({"error": f"bad request: {e}"}), 400

    return jsonify({"ok": True})


@app.post("/api/buttons/restore-defaults")
@with_device_reconnect
def api_restore_button_defaults():
    button_count = client.get_button_count(device_id)

    # Reset every profile, not just whichever one ratbagd currently reports
    # as active -- that reported value has repeatedly drifted from what the
    # hardware is actually running, leaving stale bindings behind in
    # profiles nobody was "in" at edit time.
    profiles = get_profiles()
    errors = {}
    for profile in profiles:
        for index, (action_type, value) in FACTORY_BUTTON_DEFAULTS.items():
            if index >= button_count:
                continue
            try:
                _apply_button_default(index, action_type, value, profile=profile["index"])
            except RatbagCtlError as e:
                errors[f"profile {profile['index']} button {index}"] = str(e)

    if errors:
        return jsonify({"error": "some buttons failed to restore", "details": errors}), 502
    return jsonify({"ok": True})


@app.post("/api/dpi")
@with_device_reconnect
def api_set_dpi():
    body = request.get_json(force=True, silent=True) or {}
    try:
        client.set_dpi(device_id, int(body["value"]))
    except (KeyError, ValueError) as e:
        return jsonify({"error": f"bad request: {e}"}), 400
    return jsonify({"ok": True})


@app.post("/api/resolution/<int:index>/active")
@with_device_reconnect
def api_set_active_resolution(index: int):
    client.set_active_resolution(device_id, index)
    return jsonify({"ok": True})


@app.post("/api/resolution/<int:index>/dpi")
@with_device_reconnect
def api_set_resolution_dpi(index: int):
    body = request.get_json(force=True, silent=True) or {}
    try:
        client.set_resolution_dpi(device_id, index, int(body["value"]))
    except (KeyError, ValueError) as e:
        return jsonify({"error": f"bad request: {e}"}), 400
    return jsonify({"ok": True})


@app.post("/api/rate")
@with_device_reconnect
def api_set_rate():
    body = request.get_json(force=True, silent=True) or {}
    try:
        client.set_rate(device_id, int(body["value"]))
    except (KeyError, ValueError) as e:
        return jsonify({"error": f"bad request: {e}"}), 400
    return jsonify({"ok": True})


@app.post("/api/profile")
@with_device_reconnect
def api_set_profile():
    body = request.get_json(force=True, silent=True) or {}
    try:
        client.set_active_profile(device_id, int(body["index"]))
    except (KeyError, ValueError) as e:
        return jsonify({"error": f"bad request: {e}"}), 400
    return jsonify({"ok": True})


@app.post("/api/profile/<int:index>/name")
@with_device_reconnect
def api_rename_profile(index: int):
    body = request.get_json(force=True, silent=True) or {}
    try:
        client.set_profile_name(device_id, index, str(body["name"]))
    except (KeyError, ValueError) as e:
        return jsonify({"error": f"bad request: {e}"}), 400
    return jsonify({"ok": True})


@app.get("/")
def index():
    return send_from_directory(FRONTEND_DIR, "index.html")


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5000"))
    print(f"Mode: {'MOCK' if IS_MOCK else 'REAL'} ({mode_reason})")
    print(f"Device: {device_id}")
    app.run(host="127.0.0.1", port=port, debug=os.environ.get("FLASK_DEBUG") == "1")
