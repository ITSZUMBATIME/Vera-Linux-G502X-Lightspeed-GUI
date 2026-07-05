# G502 X Control Center — setup & run

This app has three parts:

- `backend/` — a Flask server that wraps the `ratbagctl` CLI (falls back to an
  in-memory mock when `ratbagctl`/`ratbagd` or the mouse aren't available).
- `frontend/` — plain HTML/CSS/JS served by the Flask backend.
- `electron/` — a desktop shell that launches the backend and loads the frontend
  in a window. Optional — the frontend also just works in a normal browser.

## 1. Backend setup

```sh
cd app/backend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

## 2. Run against your real mouse

Prerequisites (on your machine, not in a sandbox):

```sh
# ratbagd must be running
sudo systemctl status ratbagd

# ratbagctl must see your mouse
ratbagctl list
```

If `ratbagctl list` prints a line for your G502 X, start the backend in real mode:

```sh
cd app/backend
RATBAG_MODE=real .venv/bin/python app.py
```

It prints which mode it picked and which device it's using, e.g.:

```
Mode: REAL (found device via ratbagctl: Logitech G502 X Wireless)
Device: hidraw0
```

Then open **http://127.0.0.1:5000** in a browser.

If you omit `RATBAG_MODE` (or set it to `auto`, the default), the backend
auto-detects: real hardware if `ratbagctl` is on PATH and finds a device,
otherwise it silently falls back to mock mode and shows a banner in the UI.

## 3. Run in mock mode (no mouse needed — for dev/testing)

```sh
cd app/backend
RATBAG_MODE=mock .venv/bin/python app.py
```

Open **http://127.0.0.1:5000**. The UI shows a "MOCK MODE" banner and nothing
you do touches real hardware.

## 4. Run the Electron shell instead of a browser

```sh
cd app/electron
npm install
npm start
```

This spawns the backend for you (using `backend/.venv` if it exists) and opens
it in a desktop window. Set `RATBAG_MODE` in your shell before `npm start` if
you want to force real/mock mode; otherwise it auto-detects the same way as
running the backend directly.

## Verifying the button-marker mapping on your real mouse

The app does **not** hardcode which `ratbagctl` button index corresponds to
which physical button — that correspondence is only knowable from the live
device, and can vary. Instead, on every load the backend inspects each
button's *current* action and infers its physical identity from convention
(a button mapped to its own USB HID number is a main/back/forward click; a
`wheel-left`/`wheel-right` special is a tilt button; a resolution/second-mode
special behind the wheel is the Thumb Button/DPI-Shift). Anything it can't
infer shows up marked **unidentified** in the UI (red marker) rather than a
guessed label.

Note: on this specific mouse, Forward/Backward ended up bound to the
*opposite* HID button numbers from the standard convention (button 4 =
forward, button 5 = backward) — confirmed by testing actual back/forward
navigation, not a bug. See `CLAUDE.md` before "fixing" this back.

To double check any marker against your actual hardware:

1. Go to **Settings → Verify button mapping** for the exact steps (short
   version: temporarily map the button in question to an unused key like
   `KEY_F13`, then watch `xev`/`showkey` while physically pressing the button
   on the mouse).
2. If a marker is wrong, use the **manual label override** dropdown in
   Settings to fix it — this is stored in your browser's `localStorage`, not
   on the mouse, so it's safe to experiment with.

## Troubleshooting

- **`RATBAG_MODE=real` fails immediately with "no devices found"**: run
  `sudo systemctl status ratbagd` and `ratbagctl list` directly — if `list`
  prints nothing, ratbagd isn't seeing the mouse (check `dmesg`/USB
  connection/wireless receiver pairing), it's not a bug in this app.
- **A `ratbagctl` command the backend runs fails**: the backend surfaces
  `ratbagctl`'s stderr/stdout verbatim in the API's `error` field and as a
  toast in the UI, so the message you see is `ratbagctl`'s own error.
- **RGB / battery level**: not implemented. The G502 X has no RGB lighting,
  and `ratbagctl`'s CLI has no battery-level command to read from.
