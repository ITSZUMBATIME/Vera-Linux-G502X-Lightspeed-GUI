"""Flask backend for the G502 X control app.

Wraps ratbagctl (real hardware via ratbagd) with an automatic mock fallback
so the UI is developable/testable without a physical mouse attached.
"""
from __future__ import annotations

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
mode_reason = ""


def _init_client():
    global client, device_id, mode_reason

    if MODE == "mock":
        client = MockRatbagClient()
        device_id = client.list_devices()[0]["id"]
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
                device_id = devices[0]["id"]
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
    device_id = client.list_devices()[0]["id"]


_init_client()
IS_MOCK = isinstance(client, MockRatbagClient)


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
    "4": "back",
    "5": "forward",
}

_SPECIAL_TO_ROLE = {
    "wheel-left": "wheelLeft",
    "wheel-right": "wheelRight",
    "resolution-cycle-up": "g9",
    "resolution-cycle-down": "g9",
    "resolution-alternate": "g9",
    "second-mode": "g9",
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
    return jsonify(
        {
            "mode": "mock" if IS_MOCK else "real",
            "reason": mode_reason,
            "device_id": device_id,
        }
    )


@app.get("/api/device")
def api_device():
    try:
        state = client.get_device_state(device_id)
    except RatbagCtlError as e:
        return jsonify({"error": str(e)}), 502

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
            "dpi": client.get_dpi(device_id),
            "dpi_min": state.dpi_min,
            "dpi_max": state.dpi_max,
            "rate": state.rate,
            "rate_options": state.rate_options,
            "profile_active": state.profile_active,
            "profiles": get_profiles(),
        }
    )


@app.post("/api/button/<int:index>")
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
            client.set_button_macro(device_id, index, tokens)
        elif action_type == "disabled":
            client.set_button_disabled(device_id, index)
        else:
            return jsonify({"error": f"unknown action type {action_type!r}"}), 400
    except RatbagCtlError as e:
        return jsonify({"error": str(e)}), 502
    except (KeyError, ValueError) as e:
        return jsonify({"error": f"bad request: {e}"}), 400

    return jsonify({"ok": True})


@app.post("/api/dpi")
def api_set_dpi():
    body = request.get_json(force=True, silent=True) or {}
    try:
        client.set_dpi(device_id, int(body["value"]))
    except RatbagCtlError as e:
        return jsonify({"error": str(e)}), 502
    except (KeyError, ValueError) as e:
        return jsonify({"error": f"bad request: {e}"}), 400
    return jsonify({"ok": True})


@app.post("/api/resolution/<int:index>/active")
def api_set_active_resolution(index: int):
    try:
        client.set_active_resolution(device_id, index)
    except RatbagCtlError as e:
        return jsonify({"error": str(e)}), 502
    return jsonify({"ok": True})


@app.post("/api/rate")
def api_set_rate():
    body = request.get_json(force=True, silent=True) or {}
    try:
        client.set_rate(device_id, int(body["value"]))
    except RatbagCtlError as e:
        return jsonify({"error": str(e)}), 502
    except (KeyError, ValueError) as e:
        return jsonify({"error": f"bad request: {e}"}), 400
    return jsonify({"ok": True})


@app.post("/api/profile")
def api_set_profile():
    body = request.get_json(force=True, silent=True) or {}
    try:
        client.set_active_profile(device_id, int(body["index"]))
    except RatbagCtlError as e:
        return jsonify({"error": str(e)}), 502
    except (KeyError, ValueError) as e:
        return jsonify({"error": f"bad request: {e}"}), 400
    return jsonify({"ok": True})


@app.post("/api/profile/<int:index>/name")
def api_rename_profile(index: int):
    body = request.get_json(force=True, silent=True) or {}
    try:
        client.set_profile_name(device_id, index, str(body["name"]))
    except RatbagCtlError as e:
        return jsonify({"error": str(e)}), 502
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
