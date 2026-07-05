"""Client for talking to ratbagd via the ratbagctl CLI, with a mock fallback.

ratbagctl has no JSON output mode, so every read command's stdout is plain
text and has to be parsed. The exact formats below were taken from
libratbag's tools/ratbagctl.body.py.in (the ratbagctl source).
"""
from __future__ import annotations

import re
import shutil
import subprocess
from dataclasses import dataclass, field
from typing import Optional


class RatbagCtlError(RuntimeError):
    pass


@dataclass
class Button:
    index: int
    action_type: str  # "none" | "button" | "special" | "key" | "macro" | "unknown"
    action_value: str  # e.g. "2", "profile-cycle-up", "KEY_A", "[KEY_A, ...]"
    raw: str = ""


@dataclass
class Resolution:
    index: int
    dpi: str  # "800" or "800x600"
    active: bool = False
    default: bool = False
    disabled: bool = False


@dataclass
class DeviceState:
    device_id: str
    name: str
    button_count: int
    buttons: list[Button]
    resolutions: list[Resolution]
    dpi_min: Optional[int]
    dpi_max: Optional[int]
    rate: Optional[int]
    rate_options: list[int]
    profile_active: Optional[int]
    profile_count: Optional[int] = None


BUTTON_LINE_RE = re.compile(
    r"Button:\s*(\d+)\s*is mapped to\s*(?:'([^']*)'|(disabled))"
)
RESOLUTION_LINE_RE = re.compile(
    r"^\s*(\d+):\s*([0-9x]+)dpi(\s*\(active\))?(\s*\(default\))?(\s*\(disabled\))?"
)


def _parse_button_line(line: str) -> Optional[Button]:
    m = BUTTON_LINE_RE.search(line)
    if not m:
        return None
    index = int(m.group(1))
    body = m.group(2)
    if body is None:
        return Button(index, "none", "disabled", raw=line)
    if body == "none":
        return Button(index, "none", "", raw=line)
    if body.startswith("button "):
        return Button(index, "button", body.split(" ", 1)[1], raw=line)
    if body.startswith("key "):
        return Button(index, "key", body.split(" ", 1)[1].strip("'\""), raw=line)
    if body.startswith("macro "):
        return Button(index, "macro", body.split(" ", 1)[1], raw=line)
    # special action name, printed bare e.g. 'profile-cycle-up'
    return Button(index, "special", body, raw=line)


def _parse_resolution_line(line: str) -> Optional[Resolution]:
    m = RESOLUTION_LINE_RE.match(line.strip())
    if not m:
        return None
    return Resolution(
        index=int(m.group(1)),
        dpi=m.group(2),
        active=bool(m.group(3)),
        default=bool(m.group(4)),
        disabled=bool(m.group(5)),
    )


class RealRatbagClient:
    """Shells out to the ratbagctl CLI."""

    def __init__(self, binary: str = "ratbagctl"):
        self.binary = binary

    @staticmethod
    def is_available() -> bool:
        return shutil.which("ratbagctl") is not None

    def _run(self, device: Optional[str], *args: str) -> str:
        cmd = [self.binary]
        if device is not None:
            cmd.append(device)
        cmd.extend(args)
        try:
            result = subprocess.run(
                cmd, capture_output=True, text=True, timeout=10
            )
        except FileNotFoundError as e:
            raise RatbagCtlError("ratbagctl binary not found") from e
        except subprocess.TimeoutExpired as e:
            raise RatbagCtlError(f"ratbagctl timed out: {' '.join(cmd)}") from e
        if result.returncode != 0:
            raise RatbagCtlError(
                f"ratbagctl {' '.join(args)} failed: {result.stderr.strip() or result.stdout.strip()}"
            )
        return result.stdout

    def list_devices(self) -> list[dict]:
        out = self._run(None, "list")
        devices = []
        for line in out.splitlines():
            line = line.rstrip()
            if not line.strip():
                continue
            parts = line.split(None, 1)
            if not parts:
                continue
            dev_id = parts[0].rstrip(":")
            name = parts[1].strip() if len(parts) > 1 else dev_id
            devices.append({"id": dev_id, "name": name})
        return devices

    def get_name(self, device: str) -> str:
        return self._run(device, "name").strip()

    def get_button_count(self, device: str) -> int:
        return int(self._run(device, "button", "count").strip())

    def get_button(self, device: str, index: int) -> Button:
        out = self._run(device, "button", str(index), "get")
        for line in out.splitlines():
            b = _parse_button_line(line)
            if b:
                return b
        raise RatbagCtlError(f"could not parse button {index} output: {out!r}")

    def get_all_buttons(self, device: str) -> list[Button]:
        return [self.get_button(device, i) for i in range(self.get_button_count(device))]

    def set_button_button(self, device: str, index: int, target: int) -> None:
        self._run(device, "button", str(index), "action", "set", "button", str(target))

    def set_button_key(self, device: str, index: int, key: str) -> None:
        self._run(device, "button", str(index), "action", "set", "key", key)

    def set_button_special(self, device: str, index: int, special: str) -> None:
        self._run(device, "button", str(index), "action", "set", "special", special)

    def set_button_macro(self, device: str, index: int, tokens: list[str]) -> None:
        self._run(device, "button", str(index), "action", "set", "macro", *tokens)

    def set_button_disabled(self, device: str, index: int) -> None:
        self._run(device, "button", str(index), "action", "set", "disabled")

    def get_resolutions(self, device: str) -> list[Resolution]:
        out = self._run(device, "dpi", "get-all")
        dpis = [d for d in out.strip().split() if d]
        active_idx = self.get_active_resolution(device)
        return [
            Resolution(index=i, dpi=d, active=(i == active_idx))
            for i, d in enumerate(dpis)
        ]

    def get_active_resolution(self, device: str) -> int:
        return int(self._run(device, "resolution", "active", "get").strip())

    def set_active_resolution(self, device: str, index: int) -> None:
        self._run(device, "resolution", str(index), "active", "set")

    def get_dpi(self, device: str) -> int:
        return int(self._run(device, "dpi", "get").strip())

    def set_dpi(self, device: str, value: int) -> None:
        self._run(device, "dpi", "set", str(value))

    def get_rate(self, device: str) -> int:
        return int(self._run(device, "rate", "get").strip())

    def get_rate_options(self, device: str) -> list[int]:
        out = self._run(device, "rate", "get-all")
        return [int(v) for v in out.strip().split() if v]

    def set_rate(self, device: str, value: int) -> None:
        self._run(device, "rate", "set", str(value))

    def get_active_profile(self, device: str) -> int:
        return int(self._run(device, "profile", "active", "get").strip())

    def set_active_profile(self, device: str, index: int) -> None:
        self._run(device, "profile", "active", "set", str(index))

    def get_profile_name(self, device: str, index: int) -> str:
        return self._run(device, "profile", str(index), "name", "get").strip()

    def set_profile_name(self, device: str, index: int, name: str) -> None:
        self._run(device, "profile", str(index), "name", "set", name)

    def get_device_state(self, device: str) -> DeviceState:
        name = self.get_name(device)
        buttons = self.get_all_buttons(device)
        resolutions = self.get_resolutions(device)
        rate = self.get_rate(device)
        rate_options = self.get_rate_options(device)
        profile_active = self.get_active_profile(device)
        return DeviceState(
            device_id=device,
            name=name,
            button_count=len(buttons),
            buttons=buttons,
            resolutions=resolutions,
            dpi_min=None,
            dpi_max=None,
            rate=rate,
            rate_options=rate_options,
            profile_active=profile_active,
        )


# --- Mock client -----------------------------------------------------------

# Physical layout matches the real G502 X / G502 X LIGHTSPEED (8 buttons,
# no RGB). Indices here are arbitrary mock ordering; a real device's actual
# ratbagctl indices must be discovered live (see detect_roles in app.py).
_MOCK_BUTTON_DEFAULTS = [
    ("button", "1"),              # 0 left
    ("button", "2"),              # 1 right
    ("button", "3"),              # 2 middle
    ("button", "4"),               # 3 back (G7)
    ("button", "5"),               # 4 forward (G8)
    ("special", "wheel-left"),      # 5 wheel tilt left
    ("special", "wheel-right"),     # 6 wheel tilt right
    ("special", "resolution-cycle-up"),  # 7 G9 dpi/sniper
]

_MOCK_DPI_STAGES = [400, 800, 1600, 3200, 6400, 12800, 25600]


class MockRatbagClient:
    """In-memory stand-in for a G502 X LIGHTSPEED, used when ratbagctl/ratbagd
    aren't available (e.g. this dev sandbox, or a machine with no mouse attached)."""

    def __init__(self):
        self._name = "Logitech G502 X LIGHTSPEED (mock)"
        self._buttons = [
            Button(i, t, v, raw=f"mock button {i}")
            for i, (t, v) in enumerate(_MOCK_BUTTON_DEFAULTS)
        ]
        self._dpi_stages = list(_MOCK_DPI_STAGES)
        self._active_resolution = 2  # 1600 dpi
        self._rate = 1000
        self._rate_options = [125, 250, 500, 1000]
        self._profiles = ["Default", "FPS", "Productivity"]
        self._active_profile = 0

    def list_devices(self) -> list[dict]:
        return [{"id": "mock0", "name": self._name}]

    def get_name(self, device: str) -> str:
        return self._name

    def get_button_count(self, device: str) -> int:
        return len(self._buttons)

    def get_button(self, device: str, index: int) -> Button:
        return self._buttons[index]

    def get_all_buttons(self, device: str) -> list[Button]:
        return list(self._buttons)

    def set_button_button(self, device: str, index: int, target: int) -> None:
        self._buttons[index] = Button(index, "button", str(target))

    def set_button_key(self, device: str, index: int, key: str) -> None:
        self._buttons[index] = Button(index, "key", key)

    def set_button_special(self, device: str, index: int, special: str) -> None:
        self._buttons[index] = Button(index, "special", special)

    def set_button_macro(self, device: str, index: int, tokens: list[str]) -> None:
        self._buttons[index] = Button(index, "macro", f"[{', '.join(tokens)}]")

    def set_button_disabled(self, device: str, index: int) -> None:
        self._buttons[index] = Button(index, "none", "")

    def get_resolutions(self, device: str) -> list[Resolution]:
        return [
            Resolution(i, str(d), active=(i == self._active_resolution))
            for i, d in enumerate(self._dpi_stages)
        ]

    def get_active_resolution(self, device: str) -> int:
        return self._active_resolution

    def set_active_resolution(self, device: str, index: int) -> None:
        self._active_resolution = index

    def get_dpi(self, device: str) -> int:
        return self._dpi_stages[self._active_resolution]

    def set_dpi(self, device: str, value: int) -> None:
        self._dpi_stages[self._active_resolution] = value

    def get_rate(self, device: str) -> int:
        return self._rate

    def get_rate_options(self, device: str) -> list[int]:
        return list(self._rate_options)

    def set_rate(self, device: str, value: int) -> None:
        self._rate = value

    def get_active_profile(self, device: str) -> int:
        return self._active_profile

    def set_active_profile(self, device: str, index: int) -> None:
        self._active_profile = index

    def get_profile_name(self, device: str, index: int) -> str:
        if index < 0 or index >= len(self._profiles):
            raise RatbagCtlError(f"no profile {index}")
        return self._profiles[index]

    def set_profile_name(self, device: str, index: int, name: str) -> None:
        if index < 0 or index >= len(self._profiles):
            raise RatbagCtlError(f"no profile {index}")
        self._profiles[index] = name

    def get_device_state(self, device: str) -> DeviceState:
        return DeviceState(
            device_id=device,
            name=self._name,
            button_count=len(self._buttons),
            buttons=list(self._buttons),
            resolutions=self.get_resolutions(device),
            dpi_min=100,
            dpi_max=26000,
            rate=self._rate,
            rate_options=self._rate_options,
            profile_active=self._active_profile,
            profile_count=len(self._profiles),
        )
